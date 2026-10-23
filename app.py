import json
import math

import pandas as pd
from flask import Flask, jsonify, request, send_from_directory

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 5 * 1024 * 1024  # 5 MB upload cap


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
    if hasattr(value, "item"):
        value = value.item()
    if isinstance(value, float):
        return None if math.isinf(value) else round(value, 4)
    return value


def column_stats(series):
    stats = {
        "name": str(series.name),
        "dtype": str(series.dtype),
        "missing": int(series.isna().sum()),
        "unique": int(series.nunique()),
    }
    if pd.api.types.is_numeric_dtype(series) and not pd.api.types.is_bool_dtype(series):
        for key in ("mean", "std", "min", "median", "max"):
            stats[key] = clean(getattr(series, key)())
    else:
        top = series.mode()
        stats["top"] = clean(top.iloc[0]) if len(top) else None
    return stats


def summarize(df):
    return {
        "rows": len(df),
        "columns": len(df.columns),
        "numeric": int(len(df.select_dtypes("number").columns)),
        "missing": int(df.isna().sum().sum()),
        "column_names": [str(c) for c in df.columns],
        # to_json handles NaN and timestamps; round-trip to get plain objects
        "preview": json.loads(df.head(10).to_json(orient="records", date_format="iso")),
        "stats": [column_stats(df[c]) for c in df.columns],
    }


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


if __name__ == "__main__":
    app.run(debug=True)
