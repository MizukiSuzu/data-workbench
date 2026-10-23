# Data Workbench

A small web app for quick exploratory data analysis. Upload a CSV or JSON file to see summary statistics, clean the data, draw charts and export the result.

**Live demo:** https://data-workbench-iota.vercel.app

## Features

- **Load Data**: drag and drop or pick a `.csv` / `.json` file (up to 4 MB) and preview the first 10 rows.
- **Summary Stats**: row, column, numeric-column and missing-cell counts, plus per-column dtype, missing, unique, mean, std, min, median, max and most common value.
- **Clean Data**: drop rows with missing values, fill numeric nulls with the mean, median or zero, remove duplicate rows, or drop a column. Each action is logged.
- **Visualize**: histogram, bar chart (counts or mean of Y per X), scatter plot and a correlation heatmap.
- **Export CSV**: download the current (cleaned) dataset.

## Stack

- **Backend:** Python, Flask, Pandas (NumPy under the hood)
- **Frontend:** plain JavaScript, Tailwind CSS, Chart.js
- **Hosting:** Vercel (`@vercel/python`, see `vercel.json`)

## How it works

The backend is stateless, because Vercel functions keep nothing between requests. The browser holds the working dataset:

1. `POST /api/summary` takes an uploaded file and returns the full data as JSON records, the summary stats and a correlation matrix.
2. `POST /api/clean` takes the current data as a CSV file plus an `action` (`drop_missing`, `fill_mean`, `fill_median`, `fill_zero`, `dedupe`, `drop_column` with `column`) and returns the same shape for the cleaned data.

Charts and the CSV export are built in the browser from that data.

## Run locally

Requires Python 3.11+.

```bash
python -m venv venv
venv/Scripts/pip install -r requirements.txt   # macOS/Linux: venv/bin/pip
venv/Scripts/python app.py                     # macOS/Linux: venv/bin/python
```

Then open http://127.0.0.1:5000.

## Tests

```bash
venv/Scripts/python test_app.py
```

Prints `ok` when the API checks pass.
