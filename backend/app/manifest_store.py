from typing import List, Optional
from app.schemas.manifest import EgressManifestEntry

class ManifestStore:
    def __init__(self):
        self._entries: List[EgressManifestEntry] = []

    def record(self, entry: EgressManifestEntry) -> EgressManifestEntry:
        self._entries.append(entry)
        return entry

    def list_entries(
        self,
        session_id: Optional[str] = None,
        status: Optional[str] = None
    ) -> List[EgressManifestEntry]:
        results = self._entries
        if session_id:
            results = [e for e in results if e.session_id == session_id]
        if status:
            results = [e for e in results if e.status == status]
        return results

    def get_entry(self, entry_id: str) -> Optional[EgressManifestEntry]:
        for e in self._entries:
            if e.id == entry_id:
                return e
        return None

    def clear(self):
        self._entries.clear()

manifest_store = ManifestStore()
