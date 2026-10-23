import io

from app import app


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
    assert post("d.csv", csv, "/api/clean", action="drop_column", column="zz").status_code == 400


def test_json_and_errors():
    assert post("d.json", b'[{"a": 1}, {"a": 3}]').get_json()["stats"][0]["max"] == 3
    assert post("d.txt", b"x").status_code == 400
    assert post("d.csv", b"").status_code == 400
    assert app.test_client().post("/api/summary").status_code == 400
    assert app.test_client().get("/").status_code == 200


if __name__ == "__main__":
    test_csv_summary()
    test_json_and_errors()
    test_clean_actions()
    print("ok")
