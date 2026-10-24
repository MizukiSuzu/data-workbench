# Data Workbench

A small web app for quick exploratory data analysis. Upload a CSV or JSON file to see summary statistics, clean the data, draw charts and export the result.

**Live demo:** https://data-workbench-iota.vercel.app

## Features

- **Load Data**: drag and drop or pick a `.csv` / `.json` file (up to 4 MB) and preview the first 10 rows. No file? **Try sample data** loads a made-up coffee shop sales dataset (`static/sample/coffee_sales.csv`) with missing values, duplicates, stray whitespace and outliers to clean.
- **Summary Stats**: row, column, numeric-column and missing-cell counts, plus per-column dtype, missing, unique, mean, std, min, median, max, outlier count (1.5 IQR rule) and most common value.
- **Clean Data**, with undo for every action and a log of what changed:
  - Whole dataset: drop rows with missing values, fill numeric nulls with the mean, median or zero, fill text nulls with the most common value, remove duplicates, remove outlier rows, trim whitespace.
  - One column: convert to number or date, rename, drop.
- **Visualize**: histogram, bar chart (counts or mean of Y per X), scatter plot, correlation heatmap and missing values per column.
- **Export CSV**: download the current (cleaned) dataset.
- Works on phones as well as desktop.

## Stack

- **Backend:** Python, Flask, Pandas (NumPy under the hood)
- **Frontend:** plain JavaScript, Tailwind CSS, Chart.js
- **Hosting:** Vercel (`@vercel/python`, see `vercel.json`)

## How it works

The backend is stateless, because Vercel functions keep nothing between requests. The browser holds the working dataset:

1. `POST /api/summary` takes an uploaded file and returns the full data as JSON records, the summary stats and a correlation matrix.
2. `POST /api/clean` takes the current data as a CSV file plus an `action` and returns the same shape for the cleaned data, with a `message` describing the change.
   - Whole-dataset actions: `drop_missing`, `fill_mean`, `fill_median`, `fill_zero`, `fill_mode`, `dedupe`, `remove_outliers`, `trim`.
   - Column actions (need `column`): `to_number`, `to_date`, `drop_column`, `rename` (also needs `value`, the new name).
   - Optional `dates`: a JSON list of columns to parse as dates, since CSV doesn't keep column types.

Charts, undo and the CSV export all run in the browser on that data.

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
