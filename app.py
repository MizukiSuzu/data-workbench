import json
import math

import pandas as pd
from flask import Flask, jsonify, request, send_from_directory

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 4 * 1024 * 1024  # Vercel rejects request bodies over 4.5 MB


def read_upload(file):
    name = (file.filename or "").lower()
    if name.endswith(".csv"):
        return pd.read_csv(file)
    if name.endswith(".json"):
        return pd.read_json(file)
    raise ValueError("Only .csv and .json files are supported")


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
    text = [c for c in df.columns if pd.api.types.is_string_dtype(df[c])]
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


@app.route("/")
def index():
    return send_from_directory(app.root_path, "index.html")


@app.post("/api/summary")
def summary():
    file = request.files.get("file")
    if not file:
        return jsonify(error="No file uploaded"), 400
    try:
        df = read_upload(file)
    except Exception as e:
        return jsonify(error=f"Could not read file: {e}"), 400
    return jsonify(summarize(df))


@app.post("/api/clean")
def clean_data():
    file = request.files.get("file")
    if not file:
        return jsonify(error="No file uploaded"), 400
    try:
        df = read_upload(file)
        # CSV loses dtypes, so the client says which columns are dates
        for c in json.loads(request.form.get("dates") or "[]"):
            if c in df.columns:
                df[c] = pd.to_datetime(df[c], errors="coerce", format="ISO8601")
        form = request.form
        df, message = apply_action(df, form.get("action"), form.get("column"), form.get("value"))
    except Exception as e:
        return jsonify(error=str(e)), 400
    return jsonify({**summarize(df), "message": message})


if __name__ == "__main__":
    app.run(debug=True)
