from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
import unittest

from cryptography.fernet import Fernet

from workers.historical_indexer.main import (
    as_utc_datetime,
    json_list,
    media_details,
    resolve_session_string,
)


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

    def test_multipart_caption_is_grouped(self):
        message = SimpleNamespace(
            photo=None, video=SimpleNamespace(file_unique_id="part1", mime_type="video/mp4", file_size=1234),
            document=None, animation=None, audio=None, voice=None, video_note=None, sticker=None,
            caption="ABC Movie Part 1 of 2", text=None, media_group_id=None,
            date=datetime(2026, 11, 3, 12, 0), id=43, chat=SimpleNamespace(id=-100123),
        )
        result = media_details(message, {"video"})
        self.assertEqual(result["part_group_key"], "abc movie")
        self.assertEqual(result["part_number"], 1)
        self.assertEqual(result["part_total"], 2)

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

    def test_environment_session_is_used_when_database_session_is_absent(self):
        session, source = resolve_session_string({"PYROGRAM_SESSION_STRING": " render-session "}, None)
        self.assertEqual(session, "render-session")
        self.assertEqual(source, "environment")

    def test_missing_session_allows_admin_login(self):
        session, source = resolve_session_string({}, None)
        self.assertEqual(session, "")
        self.assertEqual(source, "awaiting_admin_login")

    def test_encrypted_supabase_session_is_used_as_fallback(self):
        key = Fernet.generate_key().decode()
        encrypted = Fernet(key.encode()).encrypt(b"supabase-session").decode()
        session, source = resolve_session_string(
            {"SESSION_ENCRYPTION_KEY": key}, encrypted
        )
        self.assertEqual(session, "supabase-session")
        self.assertEqual(source, "supabase")


if __name__ == "__main__":
    unittest.main()
