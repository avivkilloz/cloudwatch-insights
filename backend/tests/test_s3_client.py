from datetime import datetime, timezone

from app.s3_client import _file_info


def test_file_info_extracts_basename_from_nested_key():
    obj = {"Key": "folder/sub/report.csv", "Size": 1234, "StorageClass": "STANDARD"}
    info = _file_info(obj)
    assert info["key"] == "folder/sub/report.csv"
    assert info["name"] == "report.csv"
    assert info["size"] == 1234
    assert info["storage_class"] == "STANDARD"


def test_file_info_handles_top_level_key():
    obj = {"Key": "report.csv", "Size": 10}
    assert _file_info(obj)["name"] == "report.csv"


def test_file_info_converts_last_modified_to_epoch_seconds():
    dt = datetime(2024, 1, 1, tzinfo=timezone.utc)
    obj = {"Key": "a.txt", "Size": 1, "LastModified": dt}
    assert _file_info(obj)["last_modified"] == int(dt.timestamp())


def test_file_info_handles_missing_last_modified():
    obj = {"Key": "a.txt", "Size": 1}
    assert _file_info(obj)["last_modified"] is None
