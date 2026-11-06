import csv
import io
import json
import math
import re
import zipfile

import numpy as np
import pandas as pd
from flask import Flask, jsonify, request, send_file, send_from_directory

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 4 * 1024 * 1024  # Vercel rejects request bodies over 4.5 MB

MAX_UNZIPPED_BYTES = 100 * 1024 * 1024
MAX_PDF_PAGES = 50


def check_zip_size(stream):
    """Refuse zip bombs: .xlsx and .docx are zip files that can unpack far bigger than 4 MB."""
    with zipfile.ZipFile(stream) as archive:
        if sum(info.file_size for info in archive.infolist()) > MAX_UNZIPPED_BYTES:
            raise ValueError("File is too large once unpacked")
    stream.seek(0)


def table_to_df(rows):
    """Turn extracted table rows (first row is the header) into a typed DataFrame."""
    width = max(len(row) for row in rows)
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    for row in rows:
        cells = [" ".join((cell or "").split()) for cell in row]  # PDF cells keep line breaks
        writer.writerow(cells + [""] * (width - len(cells)))
    buffer.seek(0)
    # Going through read_csv gives the same type detection as a CSV upload
    return pd.read_csv(buffer, thousands=",").dropna(how="all")


def usable(table):
    """Skip layout boxes that look like tables: a table needs a header, a row and 2 columns."""
    return len(table) >= 2 and len(table[0]) >= 2


def join_page_tables(page_tables):
    """Merge tables split across pages. Takes (page number, rows) pairs, returns whole tables."""
    # ponytail: joins on same column count on the next page; two unrelated tables can merge
    joined, last_page = [], None
    for page, table in page_tables:
        if joined and page == last_page + 1 and len(table[0]) == len(joined[-1][0]):
            joined[-1] += table[1:] if table[0] == joined[-1][0] else table
        else:
            joined.append(list(table))
        last_page = page
    return joined


def tables_note(tables):
    return f"Used the largest of {len(tables)} tables" if len(tables) > 1 else None


def read_excel(stream):
    check_zip_size(stream)
    book = pd.ExcelFile(stream, engine="openpyxl")
    for sheet in book.sheet_names:
        df = book.parse(sheet).dropna(how="all")
        if not df.empty:
            note = f"Read sheet '{sheet}'" if len(book.sheet_names) > 1 else None
            return df, note
    raise ValueError("No data found in the workbook")


def read_docx(stream):
    from docx import Document  # imported here to keep cold starts fast

    check_zip_size(stream)
    tables = [[[cell.text for cell in row.cells] for row in table.rows] for table in Document(stream).tables]
    tables = [t for t in tables if usable(t)]
    if not tables:
        raise ValueError("No tables found in this document")
    return table_to_df(max(tables, key=len)), tables_note(tables)


def read_pdf(stream):
    import pdfplumber  # imported here to keep cold starts fast

    with pdfplumber.open(stream) as pdf:
        pages = pdf.pages[:MAX_PDF_PAGES]
        page_tables = [(i, t) for i, page in enumerate(pages) for t in page.extract_tables() if usable(t)]
        total = len(pdf.pages)
    if not page_tables:
        raise ValueError("No tables found. Tables need visible borders, and scanned PDFs are not supported")
    tables = join_page_tables(page_tables)
    notes = [tables_note(tables), f"Read the first {MAX_PDF_PAGES} of {total} pages" if total > MAX_PDF_PAGES else None]
    return table_to_df(max(tables, key=len)), ". ".join(n for n in notes if n) or None


def read_upload(file):
    """Return (DataFrame, note for the user or None)."""
    name = (file.filename or "").lower()
    if name.endswith(".csv"):
        return pd.read_csv(file), None
    if name.endswith(".json"):
        return pd.read_json(file), None
    if name.endswith(".xlsx"):
        return read_excel(file.stream)
    if name.endswith(".docx"):
        return read_docx(file.stream)
    if name.endswith(".pdf"):
        return read_pdf(file.stream)
    raise ValueError("Supported files are CSV, JSON, Excel (.xlsx), Word (.docx) and PDF. Images are not supported")


def read_current():
    """The client's working dataset, sent back as CSV because Vercel functions keep no state."""
    file = request.files.get("file")
    if not file:
        raise ValueError("No file uploaded")
    df = pd.read_csv(file)
    # CSV loses dtypes, so the client says which columns are dates
    for c in json.loads(request.form.get("dates") or "[]"):
        if c in df.columns:
            df[c] = pd.to_datetime(df[c], errors="coerce", format="ISO8601")
    return df


def clean(value):
    """Make a pandas/numpy scalar JSON-safe (NaN/inf become null)."""
    if value is None or pd.isna(value):
        return None
    if isinstance(value, pd.Timestamp):
        return value.isoformat()
    if hasattr(value, "item"):
        value = value.item()
    if isinstance(value, float):
        return None if math.isinf(value) else round(value, 4)
    return value


def outlier_mask(series):
    """True where a value is outside 1.5 IQR of the quartiles (Tukey's rule)."""
    q1, q3 = series.quantile(0.25), series.quantile(0.75)
    iqr = q3 - q1
    return (series < q1 - 1.5 * iqr) | (series > q3 + 1.5 * iqr)


def is_number(series):
    return pd.api.types.is_numeric_dtype(series) and not pd.api.types.is_bool_dtype(series)


def text_columns(df):
    return [c for c in df.columns if pd.api.types.is_string_dtype(df[c])]


def untrimmed_cells(df):
    return sum(int(((df[c].str.strip() != df[c]) & df[c].notna()).sum()) for c in text_columns(df))


def column_stats(series):
    stats = {
        "name": str(series.name),
        "dtype": str(series.dtype),
        "missing": int(series.isna().sum()),
        "unique": int(series.nunique()),
    }
    if is_number(series):
        for key in ("mean", "std", "min", "median", "max"):
            stats[key] = clean(getattr(series, key)())
        stats["outliers"] = int(outlier_mask(series).sum())
    else:
        top = series.mode()
        stats["top"] = clean(top.iloc[0]) if len(top) else None
    return stats


def summarize(df):
    corr = df.select_dtypes("number").corr()
    return {
        "rows": len(df),
        "columns": len(df.columns),
        "numeric": int(len(df.select_dtypes("number").columns)),
        "missing": int(df.isna().sum().sum()),
        "duplicates": int(df.duplicated().sum()),
        "untrimmed": untrimmed_cells(df),
        "column_names": [str(c) for c in df.columns],
        # to_json handles NaN and timestamps; round-trip to get plain objects.
        # The client keeps this as the working dataset (Vercel functions are stateless).
        # ponytail: whole dataset round-trips per request; fine under the 4 MB cap.
        "data": json.loads(df.to_json(orient="records", date_format="iso")),
        "stats": [column_stats(df[c]) for c in df.columns],
        "correlation": {
            "columns": [str(c) for c in corr.columns],
            "matrix": [[clean(v) for v in row] for row in corr.values],
        },
    }


def apply_action(df, action, column=None, value=None):
    """Run one cleaning action; return (new_df, log message)."""
    numeric = [c for c in df.columns if is_number(df[c])]
    text = text_columns(df)
    missing = int(df[numeric].isna().sum().sum())
    if action == "drop_missing":
        out = df.dropna()
        return out, f"Dropped {len(df) - len(out)} rows with missing values"
    if action in ("fill_mean", "fill_median", "fill_zero"):
        out = df.copy()
        if action == "fill_zero":
            out[numeric] = out[numeric].fillna(0)
        else:
            out[numeric] = out[numeric].fillna(getattr(out[numeric], action[5:])())
        return out, f"Filled {missing} missing numeric cells with {action[5:]}"
    if action == "fill_mode":
        out = df.copy()
        filled = 0
        for c in text:
            top = out[c].mode()
            if len(top):
                filled += int(out[c].isna().sum())
                out[c] = out[c].fillna(top.iloc[0])
        return out, f"Filled {filled} missing text cells with the most common value"
    if action == "trim":
        out = df.copy()
        changed = 0
        for c in text:
            out[c] = out[c].str.strip()
            changed += int(((out[c] != df[c]) & df[c].notna()).sum())
        return out, f"Trimmed whitespace in {changed} text cells"
    if action == "remove_outliers":
        mask = pd.Series(False, index=df.index)
        for c in numeric:
            mask |= outlier_mask(df[c])
        return df[~mask], f"Removed {int(mask.sum())} rows with outliers (1.5 IQR rule)"
    if action == "dedupe":
        out = df.drop_duplicates()
        return out, f"Removed {len(df) - len(out)} duplicate rows"
    if action in ("drop_column", "to_number", "to_date", "rename") and column not in df.columns:
        raise ValueError(f"Unknown column: {column}")
    if action == "drop_column":
        return df.drop(columns=[column]), f"Dropped column '{column}'"
    if action in ("to_number", "to_date"):
        out = df.copy()
        if action == "to_number":
            out[column] = pd.to_numeric(df[column], errors="coerce")
        else:
            out[column] = pd.to_datetime(df[column], errors="coerce", format="mixed")
        lost = int(out[column].isna().sum() - df[column].isna().sum())
        kind = "number" if action == "to_number" else "date"
        return out, f"Converted '{column}' to {kind} ({lost} values could not be read and became empty)"
    if action == "rename":
        value = (value or "").strip()
        if not value:
            raise ValueError("New column name is empty")
        if value in df.columns:
            raise ValueError(f"Column '{value}' already exists")
        return df.rename(columns={column: value}), f"Renamed column '{column}' to '{value}'"
    raise ValueError(f"Unknown action: {action}")


def as_number(series):
    """Numbers as they are, dates as seconds; None for anything else."""
    if is_number(series):
        return series
    if pd.api.types.is_datetime64_any_dtype(series):
        return (series - series.min()).dt.total_seconds()
    return None


def skip_reason(series):
    """Why a column can't be scored, or None if it can."""
    values = series.dropna()
    unique = values.nunique()
    if len(values) < 5:
        return "Too few values"
    if unique <= 1:
        return "Same value in every row"
    if pd.api.types.is_datetime64_any_dtype(series) or pd.api.types.is_bool_dtype(series):
        return None
    if pd.api.types.is_float_dtype(series):
        return None
    if is_number(series):
        named_id = re.search(r"(^|[_\s])id$|^id[_\s]", str(series.name), re.I)
        return "Looks like an ID" if named_id and unique / len(values) >= 0.95 else None
    if unique / len(values) >= 0.95:
        return "Looks like an ID or free text"
    if unique > 50:
        return "Too many different text values to compare. If these are dates, convert them on the Clean tab"
    return None


def correlation_ratio(numbers, groups):
    """How much of the spread in numbers the groups explain, 0 to 1 (bias-corrected)."""
    pair = pd.DataFrame({"y": numbers.to_numpy(), "g": groups.to_numpy()}).dropna()
    n, k = len(pair), pair["g"].nunique()
    total = ((pair["y"] - pair["y"].mean()) ** 2).sum()
    if k < 2 or n <= k or total == 0:
        return None
    by_group = pair.groupby("g")["y"]
    between = (by_group.size() * (by_group.mean() - pair["y"].mean()) ** 2).sum()
    return math.sqrt(max(0, 1 - (1 - between / total) * (n - 1) / (n - k)))


def cramers_v(a, b):
    """Association between two sets of categories, 0 to 1 (bias-corrected)."""
    table = pd.crosstab(a, b).to_numpy(dtype=float)
    n = table.sum()
    r, c = table.shape
    if r < 2 or c < 2 or n < 2:
        return None
    expected = np.outer(table.sum(axis=1), table.sum(axis=0)) / n
    chi2 = ((table - expected) ** 2 / expected).sum()
    phi2 = max(0, chi2 / n - (r - 1) * (c - 1) / (n - 1))
    limit = min(r - (r - 1) ** 2 / (n - 1), c - (c - 1) ** 2 / (n - 1)) - 1
    return math.sqrt(phi2 / limit) if limit > 0 else None


def relation(feature, target):
    """Return (score 0-1 or None, method, direction) for a column against the goal column."""
    x, y = as_number(feature), as_number(target)
    if x is not None and y is not None:
        r = x.corr(y, min_periods=5)
        if pd.isna(r):
            return None, "Correlation", None
        return abs(r), "Correlation", "up" if r >= 0 else "down"
    if x is not None:
        return correlation_ratio(x, target), "Group differences", None
    if y is not None:
        return correlation_ratio(y, feature), "Group differences", None
    return cramers_v(feature, target), "Category match", None


def strength_label(score):
    if score >= 0.5:
        return "Strong"
    if score >= 0.3:
        return "Moderate"
    if score >= 0.1:
        return "Weak"
    return "Little or none"


def rank_by_goal(df, target):
    ranked, excluded = [], []
    for c in df.columns:
        if c == target:
            continue
        reason = skip_reason(df[c])
        score, method, direction = (None, None, None) if reason else relation(df[c], df[target])
        if score is None:
            excluded.append({"name": str(c), "reason": reason or "Not enough overlapping values"})
        else:
            ranked.append({"name": str(c), "score": clean(score), "label": strength_label(score),
                           "method": method, "direction": direction})
    return ranked, excluded


def variety(series):
    """Evenness of the values, 0 (nearly all one value) to 1 (evenly spread)."""
    numbers = as_number(series)
    values = pd.qcut(numbers, 10, duplicates="drop") if numbers is not None else series
    shares = values.value_counts(normalize=True)
    shares = shares[shares > 0]
    return float(-(shares * np.log(shares)).sum() / math.log(len(shares))) if len(shares) > 1 else 0.0


def rank_by_quality(df):
    ranked, excluded = [], []
    for c in df.columns:
        reason = skip_reason(df[c])
        if reason:
            excluded.append({"name": str(c), "reason": reason})
            continue
        filled = df[c].notna().mean()
        score = filled * variety(df[c])
        label = "Good" if score >= 0.7 else "Fair" if score >= 0.4 else "Poor"
        ranked.append({"name": str(c), "score": clean(score), "label": label, "method": f"{filled:.0%} filled"})
    return ranked, excluded


@app.route("/")
def index():
    return send_from_directory(app.root_path, "index.html")


@app.post("/api/summary")
def summary():
    file = request.files.get("file")
    if not file:
        return jsonify(error="No file uploaded"), 400
    try:
        df, note = read_upload(file)
    except Exception as e:
        return jsonify(error=f"Could not read file: {e}"), 400
    return jsonify({**summarize(df), "note": note})


@app.post("/api/clean")
def clean_data():
    try:
        df = read_current()
        form = request.form
        df, message = apply_action(df, form.get("action"), form.get("column"), form.get("value"))
    except Exception as e:
        return jsonify(error=str(e)), 400
    return jsonify({**summarize(df), "message": message})


@app.post("/api/rank")
def rank():
    target = request.form.get("target")
    try:
        df = read_current()
        if target:
            if target not in df.columns:
                raise ValueError(f"Unknown column: {target}")
            reason = skip_reason(df[target])
            if reason:
                raise ValueError(f"Can't rank against '{target}': {reason}")
            ranked, excluded = rank_by_goal(df, target)
        else:
            ranked, excluded = rank_by_quality(df)
    except Exception as e:
        return jsonify(error=str(e)), 400
    ranked.sort(key=lambda row: row["score"], reverse=True)
    return jsonify(target=target or None, ranked=ranked, excluded=excluded)


@app.post("/api/export")
def export():
    try:
        df = read_current()
        buffer = io.BytesIO()
        with pd.ExcelWriter(buffer, engine="openpyxl") as writer:
            df.to_excel(writer, index=False, sheet_name="Data")
            for row in writer.sheets["Data"].iter_rows():
                for cell in row:
                    if cell.data_type == "f":  # text starting with = must stay text, not a live formula
                        cell.data_type = "s"
    except Exception as e:
        return jsonify(error=str(e)), 400
    buffer.seek(0)
    mimetype = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    return send_file(buffer, mimetype=mimetype, as_attachment=True, download_name="data.xlsx")


if __name__ == "__main__":
    app.run(debug=True)
