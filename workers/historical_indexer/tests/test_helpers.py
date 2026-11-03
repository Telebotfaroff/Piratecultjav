from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
import unittest

from workers.historical_indexer.main import as_utc_datetime, json_list, media_details


class HistoricalIndexerHelperTests(unittest.TestCase):
    def test_naive_telegram_datetime_is_treated_as_utc(self):
        value = datetime(2026, 11, 3, 12, 30)
        result = as_utc_datetime(value)
        self.assertEqual(result, value.replace(tzinfo=timezone.utc))

    def test_aware_datetime_is_converted_to_utc(self):
        value = datetime(2026, 11, 3, 18, 0, tzinfo=timezone(timedelta(hours=5, minutes=30)))
        self.assertEqual(as_utc_datetime(value), datetime(2026, 11, 3, 12, 30, tzinfo=timezone.utc))

    def test_none_datetime_stays_none(self):
        self.assertIsNone(as_utc_datetime(None))

    def test_media_details_extracts_code_and_file_metadata(self):
        message = SimpleNamespace(
            photo=None,
            video=SimpleNamespace(file_unique_id="unique-1", mime_type="video/mp4", file_size=1234),
            document=None, animation=None, audio=None, voice=None, video_note=None, sticker=None,
            caption="New release FC2-123456",
            text=None,
            media_group_id="group-1",
            date=datetime(2026, 11, 3, 12, 0),
            id=42,
            chat=SimpleNamespace(id=-100123),
        )
        result = media_details(message, {"video"})
        self.assertIsNotNone(result)
        self.assertEqual(result["media_type"], "video")
        self.assertEqual(result["code"], "FC2-123456")
        self.assertEqual(result["file_unique_id"], "unique-1")
        self.assertEqual(result["message_date"].tzinfo, timezone.utc)

    def test_disallowed_media_is_skipped(self):
        message = SimpleNamespace(
            photo=None, video=SimpleNamespace(file_unique_id="u"), document=None,
            animation=None, audio=None, voice=None, video_note=None, sticker=None,
            caption="", text=None, media_group_id=None, date=None, id=1,
            chat=SimpleNamespace(id=-100123),
        )
        self.assertIsNone(media_details(message, {"photo"}))

    def test_json_list_falls_back_for_invalid_json(self):
        self.assertEqual(json_list("not-json", ["video"]), ["video"])


if __name__ == "__main__":
    unittest.main()
