import io

import numpy as np
import pandas as pd
from docx import Document
from openpyxl import load_workbook

from app import app, cramers_v, join_page_tables, table_to_df, usable


def post(name, body, url="/api/summary", **form):
    client = app.test_client()
    return client.post(url, data={"file": (io.BytesIO(body), name), **form})


def test_csv_summary():
    res = post("d.csv", b"a,b\n1,x\n2,\n,x\n")
    assert res.status_code == 200
    data = res.get_json()
    assert (data["rows"], data["columns"], data["numeric"], data["missing"]) == (3, 2, 1, 2)
    a, b = data["stats"]
    assert a["mean"] == 1.5 and a["missing"] == 1
    assert b["top"] == "x"
    assert data["data"][2]["a"] is None
    assert data["correlation"]["columns"] == ["a"]


def test_clean_actions():
    csv = b"a,b,c\n1,x,2\n3,,4\n,x,6\n1,x,2\n"

    def run(action, **form):
        res = post("d.csv", csv, "/api/clean", action=action, **form)
        assert res.status_code == 200, res.get_json()
        return res.get_json()

    assert run("drop_missing")["rows"] == 2
    assert run("dedupe")["rows"] == 3
    filled = run("fill_mean")
    assert round(filled["data"][2]["a"], 4) == 1.6667 and filled["missing"] == 1  # text column untouched
    assert run("fill_median")["data"][2]["a"] == 1
    assert run("fill_zero")["data"][2]["a"] == 0
    dropped = run("drop_column", column="b")
    assert dropped["column_names"] == ["a", "c"] and "message" in dropped
    assert post("d.csv", csv, "/api/clean", action="nope").status_code == 400


def test_more_clean_actions():
    csv = b"n,t,d\n1, a ,2024-01-05\n2,,bad\n3,b,2024-02-01\n4,b,2024-03-01\n100,b,\n"

    def run(action, **form):
        res = post("d.csv", csv, "/api/clean", action=action, **form)
        assert res.status_code == 200, res.get_json()
        return res.get_json()

    stats = post("d.csv", csv).get_json()["stats"]
    assert stats[0]["outliers"] == 1
    assert run("remove_outliers")["rows"] == 4
    assert run("fill_mode")["data"][1]["t"] == "b"
    trimmed = run("trim")
    assert trimmed["data"][0]["t"] == "a" and "1 text" in trimmed["message"]
    as_date = run("to_date", column="d")
    assert as_date["stats"][2]["dtype"].startswith("datetime") and "(1 values" in as_date["message"]
    assert run("to_number", column="t")["stats"][1]["dtype"] == "float64"
    assert run("rename", column="n", value="num")["column_names"][0] == "num"
    assert post("d.csv", csv, "/api/clean", action="rename", column="n", value="t").status_code == 400

    # dates survive the CSV round trip when the client lists them
    again = post("d.csv", b"d\n2024-01-05T00:00:00.000\n", "/api/clean", action="dedupe", dates='["d"]')
    assert again.get_json()["stats"][0]["dtype"].startswith("datetime")
    assert post("d.csv", csv, "/api/clean", action="drop_column", column="zz").status_code == 400


def test_json_and_errors():
    assert post("d.json", b'[{"a": 1}, {"a": 3}]').get_json()["stats"][0]["max"] == 3
    assert post("d.txt", b"x").status_code == 400
    assert post("d.csv", b"").status_code == 400
    assert app.test_client().post("/api/summary").status_code == 400
    assert app.test_client().get("/").status_code == 200


def test_documents():
    frame = pd.DataFrame({"item": ["a", "b"], "qty": [1, 2]})
    xlsx = io.BytesIO()
    with pd.ExcelWriter(xlsx) as writer:
        pd.DataFrame().to_excel(writer, sheet_name="Empty")
        frame.to_excel(writer, sheet_name="Sales", index=False)
    data = post("d.xlsx", xlsx.getvalue()).get_json()
    assert data["data"][1]["qty"] == 2 and data["note"] == "Read sheet 'Sales'"

    doc = Document()
    small = doc.add_table(rows=2, cols=2)
    small.cell(0, 0).text, small.cell(0, 1).text = "x", "y"
    big = doc.add_table(rows=3, cols=2)
    for r, row in enumerate([("item", "price"), ("a", "1,200"), ("b", "3")]):
        for c, text in enumerate(row):
            big.cell(r, c).text = text
    docx = io.BytesIO()
    doc.save(docx)
    data = post("d.docx", docx.getvalue()).get_json()
    assert data["data"][0]["price"] == 1200 and data["numeric"] == 1
    assert data["note"] == "Used the largest of 2 tables"

    empty = io.BytesIO()
    Document().save(empty)
    assert "No tables" in post("d.docx", empty.getvalue()).get_json()["error"]
    assert "Images are not supported" in post("d.png", b"x").get_json()["error"]
    assert post("d.xlsx", b"not a zip").status_code == 400
    assert post("d.pdf", b"not a pdf").status_code == 400


def test_pdf_tables_join_across_pages():
    head, a, b = ["k", "v"], ["a", "1"], ["b", "2"]
    joined = join_page_tables([(0, [head, a]), (1, [head, b]), (3, [head, a])])
    assert joined == [[head, a, b], [head, a]]
    assert table_to_df([head, [None, None], a])["v"].tolist() == [1]
    assert not usable([["only header", "x"]]) and not usable([["one"], ["column"]])


def test_ranking():
    n = 200
    rng = np.random.default_rng(1)
    x = rng.normal(size=n)
    group = np.where(x > 0, "high", "low")
    df = pd.DataFrame({
        "order_id": range(n),
        "strong": x,
        "inverse": -x + rng.normal(scale=0.1, size=n),
        "noise": rng.normal(size=n),
        "group": group,
        "same": 1,
        "code": [f"c{i}" for i in range(n)],
        "goal": x * 3 + rng.normal(scale=0.5, size=n),
    })
    body = df.to_csv(index=False).encode()
    data = post("d.csv", body, "/api/rank", target="goal").get_json()
    scores = {row["name"]: row for row in data["ranked"]}
    assert scores["strong"]["score"] > 0.9 and scores["strong"]["direction"] == "up"
    assert scores["inverse"]["direction"] == "down"
    assert scores["noise"]["label"] in ("Little or none", "Weak")
    assert scores["group"]["score"] > 0.5 and scores["group"]["method"] == "Group differences"
    assert data["ranked"][0]["score"] >= data["ranked"][-1]["score"]
    assert {row["name"] for row in data["excluded"]} == {"order_id", "same", "code"}

    # text goal, and many one-off categories score no higher than chance
    by_group = post("d.csv", body, "/api/rank", target="group").get_json()
    assert {r["name"]: r["score"] for r in by_group["ranked"]}["strong"] > 0.5
    assert cramers_v(pd.Series(["a", "b"] * 50), pd.Series(["c", "c", "d", "d"] * 25)) == 0

    quality = post("d.csv", body, "/api/rank").get_json()
    assert quality["target"] is None and any(r["name"] == "strong" for r in quality["ranked"])
    assert post("d.csv", body, "/api/rank", target="zz").status_code == 400
    assert "ID" in post("d.csv", body, "/api/rank", target="order_id").get_json()["error"]


def test_export_xlsx():
    res = post("d.csv", b"a,b,d\n1,=1+1,2024-01-05T00:00:00.000\n", "/api/export", dates='["d"]')
    assert res.status_code == 200 and res.headers["Content-Disposition"].endswith("data.xlsx")
    sheet = load_workbook(io.BytesIO(res.data)).active
    assert [c.value for c in sheet[1]] == ["a", "b", "d"]
    assert sheet["B2"].data_type == "s" and sheet["B2"].value == "=1+1"
    assert sheet["C2"].is_date
    assert post("d.csv", b"", "/api/export").status_code == 400


def test_summary_counts_problems():
    data = post("d.csv", b"a,b\n1, x\n1, x\n2,y\n").get_json()
    assert data["duplicates"] == 1 and data["untrimmed"] == 2


if __name__ == "__main__":
    test_csv_summary()
    test_json_and_errors()
    test_clean_actions()
    test_more_clean_actions()
    test_documents()
    test_pdf_tables_join_across_pages()
    test_ranking()
    test_export_xlsx()
    test_summary_counts_problems()
    print("ok")
