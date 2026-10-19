"""S3's filename search over a big bucket (s3_client.browse_bucket): it used
to give up after 20 pages, showing "Nothing here." for a file further in, and
a request that filled up mid-page skipped the rest of that page on Load more."""

from app import s3_client


class FakeBucket:
    """list_objects_v2 over sorted keys, 1000 a page, as S3 answers it."""

    def __init__(self, keys: list[str]):
        self.keys = sorted(keys)
        self.calls = 0
        self.examined = 0

    def list_objects_v2(self, Bucket, Prefix="", MaxKeys=1000, StartAfter=None, ContinuationToken=None, Delimiter=None):
        self.calls += 1
        keys = [k for k in self.keys if k.startswith(Prefix)]
        start = ContinuationToken or StartAfter
        if start:
            keys = [k for k in keys if k > start]
        if Delimiter:
            # A folder's own level: what's past the next "/" is one CommonPrefix.
            folders = sorted({Prefix + k[len(Prefix):].split("/", 1)[0] + "/" for k in keys if "/" in k[len(Prefix):]})
            files = [k for k in keys if "/" not in k[len(Prefix):]]
            self.examined += len(folders) + len(files)
            return {"CommonPrefixes": [{"Prefix": f} for f in folders], "Contents": [{"Key": k, "Size": 1} for k in files],
                    "IsTruncated": False}
        page = keys[:MaxKeys]
        self.examined += len(page)
        resp = {"Contents": [{"Key": k, "Size": 1} for k in page], "IsTruncated": len(keys) > MaxKeys}
        if resp["IsTruncated"]:
            resp["NextContinuationToken"] = page[-1]
        return resp


def _search(monkeypatch, bucket: FakeBucket, term: str, prefix: str = "", cursor=None, max_results: int = 200) -> dict:
    monkeypatch.setattr(s3_client, "_get_bucket_region", lambda *a: "eu-west-1")
    monkeypatch.setattr(s3_client.aws_client, "get_client", lambda *a: bucket)
    return s3_client.browse_bucket("1", "eu-west-1", None, "b", prefix, term, max_results, cursor)


def test_a_file_far_into_a_big_bucket_is_found(monkeypatch):
    # 30,000 files at the top, the one wanted after them: past the old 20 pages.
    bucket = FakeBucket([f"a/{i:06d}.log" for i in range(30_000)] + ["z/wanted-report.csv"])
    found = _search(monkeypatch, bucket, "wanted")
    assert [f["key"] for f in found["files"]] == ["z/wanted-report.csv"]
    assert found["scanned"] == 30_001 and found["continuation_token"] is None


def test_a_search_out_of_time_says_how_far_it_got_and_carries_on(monkeypatch):
    monkeypatch.setattr(s3_client, "SEARCH_SECONDS", 0)  # one page a request
    bucket = FakeBucket([f"{i:05d}.log" for i in range(2500)] + ["zz-wanted.csv"])
    first = _search(monkeypatch, bucket, "wanted")
    assert first["files"] == [] and first["scanned"] == 1000 and first["continuation_token"] == "after:00999.log"
    cursor, seen = first["continuation_token"], first["scanned"]
    while cursor:
        page = _search(monkeypatch, bucket, "wanted", cursor=cursor)
        seen += page["scanned"]
        cursor = page["continuation_token"]
    assert page["files"][0]["key"] == "zz-wanted.csv" and seen == 2501


def test_load_more_resumes_at_the_next_key_not_the_next_page(monkeypatch):
    bucket = FakeBucket([f"{i:04d}-match.txt" for i in range(1500)])
    first = _search(monkeypatch, bucket, "match", max_results=200)
    second = _search(monkeypatch, bucket, "match", cursor=first["continuation_token"], max_results=200)
    keys = [f["key"] for f in first["files"] + second["files"]]
    # The 201st match is the 201st key -- not the 1001st, as with a page's token.
    assert keys == [f"{i:04d}-match.txt" for i in range(400)]


def test_a_search_matches_the_path_below_the_folder(monkeypatch):
    bucket = FakeBucket(["logs/2024/app.log", "logs/2025/app.log", "logs/2024/db.log", "other/2024/app.log"])
    found = _search(monkeypatch, bucket, "2024/APP", prefix="logs/")
    assert [f["key"] for f in found["files"]] == ["logs/2024/app.log"]
    # The folder's own name isn't part of what's matched under it.
    assert _search(monkeypatch, bucket, "logs", prefix="logs/")["files"] == []


def test_a_path_is_listed_at_once_as_aws_s3_ls_lists_it(monkeypatch):
    """A real bucket: "POP/69/" past 33,000 keys, and the name scan hadn't got
    there. With a "/" it's a prefix S3 lists itself, as `aws s3 ls` does."""
    bucket = FakeBucket([f"AAA/{i:06d}.bin" for i in range(40_000)]
                        + ["POP/69/MU/fw.bin", "POP/69/SM/fw.bin", "POP/69/notes.txt", "POP/70/MU/fw.bin"])
    found = _search(monkeypatch, bucket, "POP/69/")
    assert [f["prefix"] for f in found["folders"]] == ["POP/69/MU/", "POP/69/SM/"]
    assert [f["key"] for f in found["files"]] == ["POP/69/notes.txt"]
    assert found["mode"] == "path" and bucket.calls == 1 and bucket.examined == 3
    # Without the trailing "/": the folders that start so, as aws s3 ls says.
    assert [f["prefix"] for f in _search(monkeypatch, bucket, "POP/6")["folders"]] == ["POP/69/"]
