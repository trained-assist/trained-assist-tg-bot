import importlib.util
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("query-sandbox-worker-failures.py")
SPEC = importlib.util.spec_from_file_location("query_sandbox_worker_failures", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class FailureRecordTest(unittest.TestCase):
    def test_extracts_only_allowlisted_correlation_fields(self):
        record = MODULE.failure_record({
            "timestamp": 123,
            "$metadata": {"message": '{"event":"tg.reconcile.failed","profileId":"sandbox-profile","userTaskId":"ut-123","boundary":"control_plane_status","status":401,"chatId":"private","requestId":"secret-id"}'},
            "$workers": {"scriptVersion": {"id": "version-1", "message": "sandbox-main-abc"}},
        })
        self.assertEqual(record, {
            "timestamp": 123,
            "event": "tg.reconcile.failed",
            "profileId": "sandbox-profile",
            "userTaskId": "ut-123",
            "boundary": "control_plane_status",
            "status": 401,
            "workerVersionId": "version-1",
            "workerVersionMessage": "sandbox-main-abc",
        })

    def test_ignores_other_events_and_unstructured_logs(self):
        self.assertIsNone(MODULE.failure_record({"$metadata": {"message": "ordinary line"}}))
        self.assertIsNone(MODULE.failure_record({"source": {"event": "tg.intake.accepted"}}))


if __name__ == "__main__":
    unittest.main()
