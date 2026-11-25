from __future__ import annotations
import base64, hashlib, json, logging
import asyncpg
from cryptography.fernet import Fernet
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from pyrogram import Client
from pyrogram.errors import SessionPasswordNeeded

log = logging.getLogger("piratecult.auth")

class TelegramAuthManager:
    def __init__(self, api_id, api_hash, secret):
        self.api_id, self.api_hash, self.secret = api_id, api_hash, secret
        self.client = self.phone = self.code_hash = self.admin_id = None

    def decrypt(self, value):
        item = json.loads(value)
        key = hashlib.sha256(self.secret.encode()).digest()
        raw = AESGCM(key).decrypt(base64.b64decode(item["iv"]), base64.b64decode(item["ciphertext"]), None)
        return json.loads(raw.decode())

    async def set_status(self, pool, rid, status, error=None):
        await pool.execute("UPDATE public.telegram_auth_requests SET status=$2,error=$3,updated_at=NOW() WHERE id=$1",
                           rid, status, error[:1200] if error else None)

    async def close(self):
        if self.client and self.client.is_connected:
            await self.client.disconnect()
        self.client = self.phone = self.code_hash = self.admin_id = None

    async def finish(self, pool, worker, rid):
        user = await self.client.get_me()
        session = await self.client.export_session_string()
        secret = Fernet(self.secret.encode()).encrypt(session.encode()).decode()
        await pool.execute("""INSERT INTO public.private_runtime_secrets(secret_name,encrypted_value,encryption_version,updated_at)
          VALUES('pyrogram_session_string',$1,1,NOW()) ON CONFLICT(secret_name) DO UPDATE
          SET encrypted_value=EXCLUDED.encrypted_value,encryption_version=1,updated_at=NOW()""", secret)
        await pool.execute("""INSERT INTO public.telegram_user_sessions(id,telegram_user_id,username,first_name,phone_last4)
          VALUES(1,$1,$2,$3,$4) ON CONFLICT(id) DO UPDATE SET telegram_user_id=EXCLUDED.telegram_user_id,
          username=EXCLUDED.username,first_name=EXCLUDED.first_name,phone_last4=EXCLUDED.phone_last4,connected_at=NOW(),updated_at=NOW()""",
          user.id,user.username,user.first_name,(self.phone or "")[-4:])
        await self.close()
        fresh = Client("piratecult-historical-indexer",api_id=self.api_id,api_hash=self.api_hash,session_string=session,no_updates=True)
        await fresh.start()
        if worker.client and worker.client.is_connected:
            await worker.client.stop()
        worker.client = fresh
        await self.set_status(pool,rid,"completed")
        log.info("Telegram account connected | account_id=%s",user.id)

    async def process_one(self, pool, worker):
        async with pool.acquire() as conn:
            async with conn.transaction():
                row = await conn.fetchrow("""SELECT id,admin_telegram_id,action,encrypted_payload
                  FROM public.telegram_auth_requests WHERE status='queued' ORDER BY created_at
                  FOR UPDATE SKIP LOCKED LIMIT 1""")
                if not row:
                    return False
                await conn.execute("UPDATE public.telegram_auth_requests SET status='processing' WHERE id=$1",row["id"])
        rid, admin, action = str(row["id"]), int(row["admin_telegram_id"]), row["action"]
        try:
            data = self.decrypt(row["encrypted_payload"])
            if action == "start":
                await self.close()
                self.client = Client("piratecult-login",api_id=self.api_id,api_hash=self.api_hash,in_memory=True,no_updates=True)
                await self.client.connect()
                self.phone = str(data["phone"])
                sent = await self.client.send_code(self.phone)
                self.code_hash, self.admin_id = sent.phone_code_hash, admin
                await self.set_status(pool,rid,"waiting_code")
            elif action == "code":
                if not self.client or self.admin_id != admin: raise RuntimeError("Login challenge expired.")
                try: await self.client.sign_in(self.phone,self.code_hash,str(data["code"]))
                except SessionPasswordNeeded:
                    await self.set_status(pool,rid,"waiting_password"); return True
                await self.finish(pool,worker,rid)
            elif action == "password":
                if not self.client or self.admin_id != admin: raise RuntimeError("2FA challenge expired.")
                await self.client.check_password(str(data["password"]))
                await self.finish(pool,worker,rid)
            elif action == "cancel":
                if self.admin_id == admin: await self.close()
                await self.set_status(pool,rid,"cancelled")
            elif action == "disconnect":
                if worker.client and worker.client.is_connected: await worker.client.stop()
                worker.client = None
                await self.close()
                await pool.execute("DELETE FROM public.private_runtime_secrets WHERE secret_name='pyrogram_session_string'")
                await pool.execute("DELETE FROM public.telegram_user_sessions WHERE id=1")
                await self.set_status(pool,rid,"completed")
            else: raise RuntimeError("Unsupported authentication action.")
        except Exception as exc:
            log.warning("Telegram auth request failed: %s",str(exc)[:250])
            await self.set_status(pool,rid,"failed",str(exc))
            if action in ("start","code","password"): await self.close()
        return True

    async def stop(self):
        await self.close()
