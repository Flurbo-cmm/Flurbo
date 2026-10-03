"""Regression tests for complete capture, provenance and event-specific freshness."""
import hashlib
import http.client
import json
import unittest
from io import BytesIO

from flurbo_sdk.research import build_research_prompt, evidence_observed_at, forecast_from_model, validate_model_output
from flurbo_sdk.runtime.research import FixtureForecaster, FixtureRetriever, HttpRetriever, Researcher


def record(**overrides):
    value = {"schema": "flurbo.agent-evidence.v2", "id": "e1", "url": "https://source.test/final",
             "requestedUrl": "https://source.test/start", "finalUrl": "https://source.test/final", "title": "Official release",
             "publisher": "source.test", "retrievedAt": 1000, "publisherReleasedAt": 995, "httpLastModified": None,
             "capturedBytes": 5, "completeDocument": True, "eventIds": [0, 1], "contentSha256": hashlib.sha256(b"hello").hexdigest(), "excerpt": "hello"}
    return {**value, **overrides}


class EvidenceValidation(unittest.TestCase):
    def check(self, evidence, requirements=None):
        output = {"schema": "flurbo.agent-model-forecast.v1", "abstain": False, "abstainReason": None,
                  "events": [0, 1], "statesPpm": [250000] * 4, "evidenceIds": ["e1"], "assumptions": [],
                  "uncertainty": "Source uncertainty", "explanation": "A documented estimate."}
        ctx = {"requestedEvents": [0, 1], "eventCount": 2, "evidence": evidence, "now": 1000, "maxEvidenceAgeSeconds": 10}
        if requirements is not None:
            ctx["evidenceRequirements"] = requirements
        return validate_model_output(json.dumps(output), ctx)

    def test_release_time_is_not_retrieval_or_last_modified(self):
        self.assertEqual(self.check([record()])["status"], "ok")
        self.assertEqual(self.check([record(publisherReleasedAt=None, httpLastModified=1000)])["reason"], "stale_evidence")
        background = [{"event": i, "freshness": "background"} for i in (0, 1)]
        self.assertEqual(self.check([record(publisherReleasedAt=None)], background)["status"], "ok")
        self.assertEqual(self.check([record(publisherReleasedAt=None)], background[:1])["reason"], "stale_evidence")

    def test_coverage_and_invalid_citations(self):
        self.assertEqual(self.check([record(eventIds=[0])])["reason"], "missing_event_evidence")
        for changes in ({"completeDocument": False}, {"capturedBytes": 0}, {"excerpt": " "}, {"schema": "old"},
                        {"publisherReleasedAt": 1001}, {"eventIds": [True]}, {"contentSha256": hashlib.sha256(b"").hexdigest()}):
            self.assertEqual(self.check([record(**changes)])["reason"], "invalid_evidence", changes)

    def test_forecast_preserves_freshness_basis_and_excludes_unknown_or_unrelated_records(self):
        values = [record(id="old", publisherReleasedAt=1), record(id="unknown", publisherReleasedAt=None),
                  record(id="unrelated", eventIds=[2]), record(id="fresh")]
        output = {"events": [0, 1], "statesPpm": [250000] * 4, "evidenceIds": [e["id"] for e in values],
                  "assumptions": [], "uncertainty": "Uncertain", "explanation": "A documented estimate."}
        forecast = forecast_from_model(output, "0xabc", values, {"kind": "fixture", "name": "test"}, 1000)
        self.assertEqual([e["id"] for e in forecast["evidence"]], ["old", "fresh"])
        self.assertEqual(forecast["evidence"][0]["observedAt"], "1970-01-01T00:00:01.000Z")
        policies = [{"event": 0, "freshness": "background"}, {"event": 1, "freshness": "release"}]
        self.assertIsNone(evidence_observed_at(values[1], [0, 1], policies))
        self.assertEqual(evidence_observed_at(values[1], [0], policies), 1000)

    def test_prompt_labels_event_policies_and_drops_invalid_evidence(self):
        event = {"index": 0, "question": "Question", "yesRule": "Yes", "noRule": "No", "observationEndsAt": 900}
        prompt = build_research_prompt("Test", [event], [record(), record(id="bad", completeDocument=False)], 1000, [{"event": 0, "freshness": "background"}], 2)
        self.assertIn("Event 0 evidence requirement: background", prompt["user"])
        self.assertNotIn('id="bad"', prompt["user"])
        self.assertIn('events="0,1"', prompt["user"])

    def test_invalid_ids_and_filtered_duplicate_ids_cannot_hide_provenance(self):
        self.assertEqual(self.check([record(id=[])])["reason"], "invalid_evidence")
        reply = json.dumps({"schema": "flurbo.agent-model-forecast.v1", "abstain": False, "abstainReason": None,
                            "events": [0, 1], "statesPpm": [250000] * 4, "evidenceIds": ["e1"], "assumptions": [],
                            "uncertainty": "Uncertain", "explanation": "A documented estimate."})
        engine = Researcher(FixtureRetriever([record(), record(completeDocument=False)]), FixtureForecaster(reply), 10, 1, 1, now=lambda: 1000)
        events = [{"index": i, "question": "Question", "yesRule": "Yes", "noRule": "No", "observationEndsAt": 900} for i in (0, 1)]
        result = engine.research("0xabc", "Test", 2, events, [])
        self.assertEqual(result["reason"], "invalid_evidence")
        self.assertEqual(len(result["evidence"]), 2)

class Response(BytesIO):
    status = 200
    def __init__(self, body):
        super().__init__(body)
        self.headers = {"Content-Type": "text/plain", "Last-Modified": "Sat, 26 Sep 2026 10:00:00 GMT"}


class Opener:
    def __init__(self, body):
        self.body = body
    def open(self, request, timeout):
        return Response(self.body)


class CompleteRetrieval(unittest.TestCase):
    def test_never_cite_oversized_or_empty_documents(self):
        for body in (b"", b"x" * 11, b" " * 5):
            retriever = HttpRetriever(["source.test"], max_bytes=10, opener=Opener(body))
            self.assertEqual(retriever.retrieve([{"event": 0, "url": "https://source.test/start"}], 1000), [])

    def test_transport_time_is_diagnostic_only(self):
        retriever = HttpRetriever(["source.test"], max_bytes=10, opener=Opener(b"hello"))
        value = retriever.retrieve([{"event": 1, "url": "https://source.test/start"}], 1000)[0]
        self.assertIsNone(value["publisherReleasedAt"])
        self.assertIsNotNone(value["httpLastModified"])
        self.assertEqual(value["eventIds"], [1])
        self.assertEqual(value["capturedBytes"], 5)
        self.assertTrue(value["completeDocument"])

    def test_partial_and_interrupted_capture_is_not_evidence(self):
        for status, headers in ((206, {}), (200, {"Content-Range": "bytes 0-4/10"}), (200, {"Content-Range": ""}),
                                (200, {"Content-Length": "10"}), (200, {"Content-Length": "invalid"})):
            class PartialOpener:
                def open(self, request, timeout):
                    result = Response(b"hello")
                    result.status = status
                    result.headers.update(headers)
                    return result
            self.assertEqual(HttpRetriever(["source.test"], opener=PartialOpener()).retrieve([{"event": 0, "url": "https://source.test/start"}], 1000), [])
        class Interrupted(Response):
            def read(self, count):
                raise http.client.IncompleteRead(b"hello", 10)
        class InterruptedOpener:
            def open(self, request, timeout):
                return Interrupted(b"hello")
        self.assertEqual(HttpRetriever(["source.test"], opener=InterruptedOpener()).retrieve([{"event": 0, "url": "https://source.test/start"}], 1000), [])


if __name__ == "__main__":
    unittest.main()
