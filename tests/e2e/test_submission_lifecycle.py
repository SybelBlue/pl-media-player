from __future__ import annotations

import copy
from pathlib import Path
from typing import Any

import lxml.html
import pytest
from prairielearn_e2e import PrairieLearnBackend


COURSE_ROOT = Path(__file__).resolve().parents[2]
QUESTION_ROOT = COURSE_ROOT / "questions" / "media" / "audio-limited"
ELEMENT_HTML = """
<pl-media-player
  file-name="demo.wav"
  max-plays="2"
  player-id="submission-test"
></pl-media-player>
"""
PLAYBACK_COUNT_NAME = "_pl_media_player_plays_submission-test"


@pytest.fixture(scope="module")
def backend(tmp_path_factory: pytest.TempPathFactory) -> PrairieLearnBackend:
    core_elements = tmp_path_factory.mktemp("core-elements")
    return PrairieLearnBackend(
        course_root=COURSE_ROOT,
        core_elements_path=core_elements,
        commit="test",
    )


@pytest.fixture
def prepared_variant(backend: PrairieLearnBackend) -> dict[str, Any]:
    base = {
        "params": {},
        "correct_answers": {},
        "variant_seed": 12345,
        "options": {
            "question_path": str(QUESTION_ROOT),
            "client_files_question_path": str(QUESTION_ROOT / "clientFilesQuestion"),
            "client_files_course_path": str(COURSE_ROOT / "clientFilesCourse"),
            "server_files_course_path": str(COURSE_ROOT / "serverFilesCourse"),
            "course_extensions_path": str(COURSE_ROOT / "elementExtensions"),
            "client_files_question_url": "/clientFilesQuestion",
            "client_files_course_url": "/clientFilesCourse",
            "client_files_question_dynamic_url": "/generatedFilesQuestion",
            "course_element_files_url": "/courseElements",
            "course_element_extension_files_url": "/courseElementExtensions",
            "submission_files_url": "/submissionFiles",
            "variant_id": 67890,
            "external_image_capture_url": "/externalImageCapture",
            "base_url": "/pl",
            "workspace_url": None,
            "user": None,
            "group": None,
        },
        "preferences": {
            "startTime": None,
            "timeLimitMin": None,
            "showClosedAssessment": False,
            "showCorrectAnswer": True,
            "showFeedback": True,
            "showHints": True,
            "showPartialScore": True,
            "showScore": True,
        },
    }
    prepare_data = {**copy.deepcopy(base), "answers_names": {}}
    backend.process("prepare", ELEMENT_HTML, prepare_data)
    base["params"] = prepare_data["params"]
    base["correct_answers"] = prepare_data["correct_answers"]
    return base


def _parse_submission(
    backend: PrairieLearnBackend,
    variant: dict[str, Any],
    plays_used: int,
) -> dict[str, Any]:
    raw_submitted_answers = {PLAYBACK_COUNT_NAME: str(plays_used)}
    data = {
        **copy.deepcopy(variant),
        "submitted_answers": copy.deepcopy(raw_submitted_answers),
        "format_errors": {},
        "raw_submitted_answers": raw_submitted_answers,
        "feedback": {},
        "gradable": True,
    }

    backend.process("parse", ELEMENT_HTML, data)
    return data


def _render_submission(
    backend: PrairieLearnBackend,
    variant: dict[str, Any],
    submission: dict[str, Any],
    submission_number: int,
) -> lxml.html.HtmlElement:
    data = {
        **copy.deepcopy(variant),
        "submitted_answers": submission["submitted_answers"],
        "format_errors": submission["format_errors"],
        "raw_submitted_answers": submission["raw_submitted_answers"],
        "partial_scores": {},
        "score": 0.0,
        "feedback": submission["feedback"],
        "editable": True,
        "manual_grading": False,
        "ai_grading": False,
        "panel": "question",
        "correct_answer_shown": False,
        "num_valid_submissions": submission_number,
    }
    rendered, _ = backend.process("render", ELEMENT_HTML, data)
    assert rendered is not None
    return lxml.html.fragment_fromstring(rendered)


def _playback_count(document: lxml.html.HtmlElement) -> str:
    inputs = document.xpath(
        './/input[contains(concat(" ", normalize-space(@class), " "), '
        '" pl-media-player-playback-count ")]'
    )
    assert len(inputs) == 1
    return inputs[0].get("value")


def test_playback_count_survives_multiple_ungraded_submissions(
    backend: PrairieLearnBackend,
    prepared_variant: dict[str, Any],
) -> None:
    assert prepared_variant["correct_answers"] == {}

    first_submission = _parse_submission(backend, prepared_variant, plays_used=1)

    assert first_submission["raw_submitted_answers"] == {PLAYBACK_COUNT_NAME: "1"}
    assert first_submission["submitted_answers"] == {}
    first_rerender = _render_submission(backend, prepared_variant, first_submission, 1)
    restored_count = _playback_count(first_rerender)
    assert restored_count == "1"

    second_submission = _parse_submission(
        backend,
        prepared_variant,
        plays_used=int(restored_count) + 1,
    )

    assert second_submission["raw_submitted_answers"] == {PLAYBACK_COUNT_NAME: "2"}
    assert second_submission["submitted_answers"] == {}
    assert (
        _playback_count(
            _render_submission(backend, prepared_variant, second_submission, 2)
        )
        == "2"
    )
