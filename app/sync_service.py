"""
Freedify Sync Service
mDNS advertising and device discovery via zeroconf.
WebSocket client tracking with asyncio.Lock for concurrency safety.
"""

import socket
import asyncio
import time
import logging

_ZEROCONF_AVAILABLE = False
ServiceInfo = Zeroconf = ServiceBrowser = ServiceListener = None

def _lazy_load_zeroconf():
    global _ZEROCONF_AVAILABLE, ServiceInfo, Zeroconf, ServiceBrowser, ServiceListener
    if _ZEROCONF_AVAILABLE:
        return True
    try:
        from zeroconf import ServiceInfo as _SI, Zeroconf as _ZC, ServiceBrowser as _SB, ServiceListener as _SL
        ServiceInfo, Zeroconf, ServiceBrowser, ServiceListener = _SI, _ZC, _SB, _SL
        _ZEROCONF_AVAILABLE = True
        return True
    except Exception:
        return False

logger = logging.getLogger(__name__)


def get_local_ip() -> str:
    """Get the local network IP address."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    finally:
        s.close()


class SyncService:
    def __init__(self):
        self._zeroconf = None
        self._info = None
        self.clients: set = set()
        self._clients_lock = asyncio.Lock()

    def _start_advertising_sync(self, port: int = 8000):
        """Synchronous inner — must be run in executor from async context."""
        if not _lazy_load_zeroconf():
            logger.warning("zeroconf not available — mDNS advertising disabled")
            return
        try:
            hostname = socket.gethostname()
            local_ip = get_local_ip()
            self._info = ServiceInfo(
                "_freedify._tcp.local.",
                f"freedify-{hostname}._freedify._tcp.local.",
                addresses=[socket.inet_aton(local_ip)],
                port=port,
                properties={"version": "1.0"},
            )
            self._zeroconf = Zeroconf()
            self._zeroconf.register_service(self._info)
            logger.info(f"mDNS: advertising as freedify-{hostname} on {local_ip}:{port}")
        except Exception as e:
            logger.warning(f"mDNS advertising failed (manual IP fallback available): {e}")

    async def start_advertising(self, port: int = 8000):
        """Non-blocking. Runs Zeroconf registration in thread-pool executor."""
        loop = asyncio.get_running_loop()
        await loop.run_in_executor(None, self._start_advertising_sync, port)

    def _stop_advertising_sync(self):
        """Synchronous inner — must be run in executor from async context."""
        if self._zeroconf:
            try:
                if self._info:
                    self._zeroconf.unregister_service(self._info)
                self._zeroconf.close()
            except Exception as e:
                logger.warning(f"mDNS cleanup error: {e}")
            self._zeroconf = None

    async def stop_advertising(self):
        """Non-blocking. Runs Zeroconf teardown in thread-pool executor."""
        loop = asyncio.get_running_loop()
        await loop.run_in_executor(None, self._stop_advertising_sync)

    async def discover_devices(self, timeout: float = 3.0) -> list[dict]:
        """Non-blocking discovery. Runs ServiceBrowser in executor."""
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(None, self._discover_sync, timeout)

    def _discover_sync(self, timeout: float) -> list[dict]:
        if not _lazy_load_zeroconf():
            return []
        results = []

        class _Listener(ServiceListener):
            def add_service(self, zc, type_, name):
                info = zc.get_service_info(type_, name)
                if info and info.addresses:
                    ip = socket.inet_ntoa(info.addresses[0])
                    results.append({
                        "name": name.split(".")[0],
                        "ip": ip,
                        "port": info.port,
                    })

            def remove_service(self, zc, type_, name):
                pass

            def update_service(self, zc, type_, name):
                pass

        try:
            zc = Zeroconf()
            browser = ServiceBrowser(zc, "_freedify._tcp.local.", _Listener())
            time.sleep(timeout)
            browser.cancel()
            zc.close()
        except Exception as e:
            logger.warning(f"mDNS discovery failed: {e}")

        return results


sync_service = SyncService()
