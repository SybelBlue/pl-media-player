from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest


CONTROLLER_PATH = Path(__file__).with_name("pl-media-player.py")
SPEC = importlib.util.spec_from_file_location(
    "pl_media_player_element", CONTROLLER_PATH
)
assert SPEC is not None and SPEC.loader is not None
media_player = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(media_player)


@pytest.fixture
def data(tmp_path: Path):
    question_root = tmp_path / "question"
    course_root = tmp_path / "course"
    question_root.mkdir()
    course_root.mkdir()
    return {
        "params": {},
        "variant_seed": 12345,
        "options": {
            "client_files_question_path": str(question_root),
            "client_files_course_path": str(course_root),
            "client_files_question_url": "/q/7/clientFilesQuestion",
            "client_files_course_url": "/pl/course/4/clientFilesCourse",
            "variant_id": 99,
        },
    }


def write_media(data, relative: str, *, course: bool = False) -> Path:
    option = "client_files_course_path" if course else "client_files_question_path"
    path = Path(data["options"][option]) / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"demo media")
    return path


def prepare(html: str, data, index: int = 0) -> None:
    media_player._prepare_with_index(html, data, index)


def render(html: str, data, index: int = 0) -> str:
    return media_player._render_with_index(html, data, index)


def test_explicit_question_file_is_resolved_and_rendered(data):
    write_media(data, "clips/hello.wav")
    html = '<pl-media-player file-name="clips/hello.wav"></pl-media-player>'

    prepare(html, data)
    output = render(html, data)

    assert (
        data["params"][media_player.PARAMS_KEY]["auto-1"]["file_name"]
        == "clips/hello.wav"
    )
    assert 'src="/q/7/clientFilesQuestion/clips/hello.wav"' in output
    assert "<audio" in output


def test_explicit_course_file_uses_course_root_and_url(data):
    write_media(data, "shared/demo.mp4", course=True)
    html = (
        '<pl-media-player file-name="shared/demo.mp4" '
        'directory="clientFilesCourse"></pl-media-player>'
    )

    prepare(html, data)
    output = render(html, data)

    assert 'src="/pl/course/4/clientFilesCourse/shared/demo.mp4"' in output
    assert "<video" in output


def test_directory_discovery_filters_extensions_and_persists_selection(data):
    write_media(data, "clips/a.wav")
    write_media(data, "clips/b.mp3")
    write_media(data, "clips/ignore.mp4")
    html = (
        '<pl-media-player source-directory="clips" randomize="true" '
        'media-type="audio" extensions="wav, mp3"></pl-media-player>'
    )

    prepare(html, data)
    selected = data["params"][media_player.PARAMS_KEY]["auto-1"]["file_name"]
    write_media(data, "clips/new.wav")
    output = render(html, data)

    assert selected in {"clips/a.wav", "clips/b.mp3"}
    assert f"/q/7/clientFilesQuestion/{selected}" in output


def test_random_selection_changes_with_variant_seed(data):
    for index in range(10):
        write_media(data, f"clips/{index}.wav")
    html = (
        '<pl-media-player source-directory="clips" randomize="true"></pl-media-player>'
    )

    selected = set()
    for seed in range(20):
        variant = {**data, "params": {}, "variant_seed": seed}
        prepare(html, variant)
        selected.add(variant["params"][media_player.PARAMS_KEY]["auto-1"]["file_name"])

    assert len(selected) > 1


def test_multiple_instances_have_independent_selections_and_ids(data):
    for index in range(8):
        write_media(data, f"clips/{index}.wav")
    html = (
        '<pl-media-player source-directory="clips" randomize="true"></pl-media-player>'
    )

    prepare(html, data, 0)
    prepare(html, data, 1)

    state = data["params"][media_player.PARAMS_KEY]
    assert set(state) == {"auto-1", "auto-2"}
    assert state["auto-1"]["file_name"] != state["auto-2"]["file_name"]


def test_empty_or_missing_discovery_directory_has_clear_error(data):
    Path(data["options"]["client_files_question_path"], "empty").mkdir()

    with pytest.raises(ValueError, match="No supported media files"):
        prepare(
            '<pl-media-player source-directory="empty" randomize="true"></pl-media-player>',
            data,
        )
    with pytest.raises(FileNotFoundError, match="Directory .* not found"):
        prepare(
            '<pl-media-player source-directory="missing" randomize="true"></pl-media-player>',
            {**data, "params": {}},
        )


def test_missing_file_and_path_traversal_are_rejected(data):
    with pytest.raises(FileNotFoundError, match="not found"):
        prepare('<pl-media-player file-name="missing.wav"></pl-media-player>', data)

    for path in ("../secret.wav", "/absolute.wav", "nested/../../secret.wav"):
        with pytest.raises(ValueError, match="stay inside"):
            prepare(
                f'<pl-media-player file-name="{path}"></pl-media-player>',
                {**data, "params": {}},
            )


def test_directory_discovery_rejects_symlink_escape(data, tmp_path):
    directory = Path(data["options"]["client_files_question_path"], "clips")
    directory.mkdir()
    outside = tmp_path / "outside.wav"
    outside.write_bytes(b"outside")
    (directory / "escape.wav").symlink_to(outside)

    with pytest.raises(ValueError, match="resolves outside"):
        prepare(
            '<pl-media-player source-directory="clips" randomize="true"></pl-media-player>',
            data,
        )


@pytest.mark.parametrize(
    ("html", "message"),
    [
        ("<pl-media-player></pl-media-player>", "Provide file-name"),
        (
            '<pl-media-player file-name="clip.wav" randomize="true"></pl-media-player>',
            "cannot be combined",
        ),
        (
            '<pl-media-player source-directory="clips" randomize="false"></pl-media-player>',
            "Provide file-name",
        ),
        (
            '<pl-media-player file-name="clip.wav" max-plays="0"></pl-media-player>',
            "at least 1",
        ),
        (
            '<pl-media-player file-name="clip.wav" player-id="not valid"></pl-media-player>',
            "player-id",
        ),
    ],
)
def test_invalid_configurations_are_rejected(data, html, message):
    write_media(data, "clip.wav")
    Path(data["options"]["client_files_question_path"], "clips").mkdir(exist_ok=True)

    with pytest.raises(ValueError, match=message):
        prepare(html, data)


def test_duplicate_explicit_player_id_is_rejected(data):
    write_media(data, "clip.wav")
    html = '<pl-media-player file-name="clip.wav" player-id="same"></pl-media-player>'

    prepare(html, data, 0)
    with pytest.raises(ValueError, match="Duplicate player-id"):
        prepare(html, data, 1)


def test_render_configuration_uses_variant_and_stable_player_identity(data):
    write_media(data, "folder name/clip.wav")
    html = (
        '<pl-media-player file-name="folder name/clip.wav" player-id="prompt" '
        'max-plays="2" allow-pause="false" allow-seeking="false" '
        'persist="variant"></pl-media-player>'
    )

    prepare(html, data)
    output = render(html, data)
    document = media_player.lxml.html.fragment_fromstring(output)
    config = json.loads(document.attrib["data-pl-media-player-config"])

    assert "folder%20name/clip.wav" in output
    assert config == {
        "allowPause": False,
        "allowSeeking": False,
        "maxPlays": 2,
        "persist": True,
        "playerId": "prompt",
        "showRemaining": True,
        "variantId": "99",
    }
