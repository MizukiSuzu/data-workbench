# Data Workbench

A small web app for quick exploratory data analysis. Load a table from a CSV, JSON, Excel, Word or PDF file, see summary statistics, clean the data, find which columns matter, draw charts and download the result as CSV or Excel.

**Live demo:** https://data-workbench-iota.vercel.app

## Features

- **Guide**: an interactive tour for beginners. Each step highlights part of the app and lets you try it, or do it for you. Plain-English explanations of every statistic sit next to the results.
- **Load Data**: drag and drop or pick a `.csv`, `.json`, `.xlsx`, `.docx` or `.pdf` file (up to 4 MB) and preview the first 10 rows. Word and PDF files use the largest table, and PDF tables need visible borders. Scans and images are not supported. No file? **Try sample data** loads a made-up coffee shop sales dataset (`static/sample/coffee_sales.csv`) with missing values, duplicates, stray whitespace and outliers to clean.
- **Summary Stats**: row, column, numeric-column and missing-cell counts, plus per-column dtype, missing, unique, mean, std, min, median, max, outlier count (1.5 IQR rule) and most common value.
- **Clean Data**, with suggestions based on the loaded data, undo for every action and a log of what changed:
  - Whole dataset: drop rows with missing values, fill numeric nulls with the mean, median or zero, fill text nulls with the most common value, remove duplicates, remove outlier rows, trim whitespace.
  - One column: convert to number or date, rename, drop.
- **Rank Columns**: pick a goal column to rank the others from most to least related to it. With no goal, columns are rated on data quality (how complete and varied they are). ID-like and constant columns are left out, with the reason shown.
- **Visualize**: histogram, bar chart (counts or mean of Y per X), scatter plot, correlation heatmap and missing values per column.
- **Export**: download the current (cleaned) dataset as CSV or Excel.
- Works on phones as well as desktop.

## Stack

- **Backend:** Python, Flask, Pandas, NumPy, openpyxl (Excel), python-docx (Word), pdfplumber (PDF)
- **Frontend:** plain JavaScript, Tailwind CSS, Chart.js
- **Hosting:** Vercel (`@vercel/python`, see `vercel.json`)

## How it works

The backend is stateless, because Vercel functions keep nothing between requests. The browser holds the working dataset:

1. `POST /api/summary` takes an uploaded file and returns the full data as JSON records, the summary stats and a correlation matrix.
2. `POST /api/clean` takes the current data as a CSV file plus an `action` and returns the same shape for the cleaned data, with a `message` describing the change.
   - Whole-dataset actions: `drop_missing`, `fill_mean`, `fill_median`, `fill_zero`, `fill_mode`, `dedupe`, `remove_outliers`, `trim`.
   - Column actions (need `column`): `to_number`, `to_date`, `drop_column`, `rename` (also needs `value`, the new name).
   - Optional `dates`: a JSON list of columns to parse as dates, since CSV doesn't keep column types.

3. `POST /api/rank` takes the current data and an optional `target` column, and returns scores from 0 to 1. The method depends on the column types: absolute Pearson correlation (number and number), bias-corrected correlation ratio (number and text) or bias-corrected Cramér's V (text and text). These show association, not cause.
4. `POST /api/export` takes the current data and returns an `.xlsx` file. Text starting with `=` stays text rather than becoming a live formula.

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
