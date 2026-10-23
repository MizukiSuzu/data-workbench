import io

from app import app


def post(name, body):
    client = app.test_client()
    return client.post("/api/summary", data={"file": (io.BytesIO(body), name)})


def test_csv_summary():
    res = post("d.csv", b"a,b\n1,x\n2,\n,x\n")
    assert res.status_code == 200
    data = res.get_json()
    assert (data["rows"], data["columns"], data["numeric"], data["missing"]) == (3, 2, 1, 2)
    a, b = data["stats"]
    assert a["mean"] == 1.5 and a["missing"] == 1
    assert b["top"] == "x"
    assert data["preview"][2]["a"] is None


def test_json_and_errors():
    assert post("d.json", b'[{"a": 1}, {"a": 3}]').get_json()["stats"][0]["max"] == 3
    assert post("d.txt", b"x").status_code == 400
    assert post("d.csv", b"").status_code == 400
    assert app.test_client().post("/api/summary").status_code == 400
    assert app.test_client().get("/").status_code == 200


if __name__ == "__main__":
    test_csv_summary()
    test_json_and_errors()
    print("ok")
