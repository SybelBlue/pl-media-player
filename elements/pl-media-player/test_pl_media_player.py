from __future__ import annotations

import importlib.util
import json
import sys
from dataclasses import FrozenInstanceError
from pathlib import Path

import pytest


CONTROLLER_PATH = Path(__file__).with_name("pl-media-player.py")
SPEC = importlib.util.spec_from_file_location(
    "pl_media_player_element", CONTROLLER_PATH
)
assert SPEC is not None and SPEC.loader is not None
media_player = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = media_player
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


def parse(html: str, data, index: int = 0) -> None:
    media_player._parse_with_index(html, data, index)


def test_config_is_frozen_portable_and_validated():
    element = media_player._element(
        '<pl-media-player file-name="clip.wav" max-plays="2" '
        'persist="variant"></pl-media-player>'
    )

    config = media_player.Config.from_element(element, 0)

    assert config.to_client_dict("variant-1") == {
        "allowMuting": False,
        "allowPause": True,
        "allowSeeking": True,
        "maxPlays": 2,
        "persist": True,
        "playerId": "auto-1",
        "showRemaining": True,
        "variantId": "variant-1",
    }
    with pytest.raises(FrozenInstanceError):
        setattr(config, "max_plays", 3)


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


def test_external_url_is_preserved_and_rendered(data):
    html = (
        '<pl-media-player url="https://cdn.example.test/media/clip.mp3?token=a%20b&amp;v=2">'
        "</pl-media-player>"
    )

    prepare(html, data)
    output = render(html, data)
    document = media_player.lxml.html.fragment_fromstring(output)
    source = document.xpath(".//source")[0]

    assert data["params"][media_player.PARAMS_KEY]["auto-1"] == {
        "media_type": "audio",
        "url": "https://cdn.example.test/media/clip.mp3?token=a%20b&v=2",
    }
    assert source.attrib == {
        "src": "https://cdn.example.test/media/clip.mp3?token=a%20b&v=2",
        "type": "audio/mpeg",
    }
    assert "<audio" in output


def test_extensionless_external_url_uses_explicit_media_type(data):
    html = (
        '<pl-media-player url="https://media.example.test/playback?id=example" '
        'media-type="video"></pl-media-player>'
    )

    prepare(html, data)
    output = render(html, data)
    document = media_player.lxml.html.fragment_fromstring(output)
    source = document.xpath(".//source")[0]

    assert source.attrib == {"src": "https://media.example.test/playback?id=example"}
    assert "<video" in output


@pytest.mark.parametrize(
    "url",
    [
        "https://www.youtube.com/watch?v=VIDEO_ID",
        "https://youtu.be/VIDEO_ID?t=43",
        "https://m.youtube.com/shorts/VIDEO_ID",
        "https://www.youtube.com/live/VIDEO_ID",
        "https://www.youtube-nocookie.com/embed/VIDEO_ID",
    ],
)
def test_youtube_urls_render_as_embed_iframes(data, url):
    html = f'<pl-media-player url="{url}"></pl-media-player>'

    prepare(html, data)
    output = render(html, data)
    document = media_player.lxml.html.fragment_fromstring(output)
    iframe = document.xpath(".//iframe")[0]

    assert data["params"][media_player.PARAMS_KEY]["auto-1"] == {
        "youtube_embed_url": "https://www.youtube.com/embed/VIDEO_ID"
    }
    assert iframe.attrib == {
        "allow": "accelerometer; autoplay; clipboard-write; encrypted-media; "
        "gyroscope; picture-in-picture; web-share",
        "allowfullscreen": "",
        "class": "pl-media-player-youtube",
        "frameborder": "0",
        "height": "315",
        "referrerpolicy": "strict-origin-when-cross-origin",
        "src": "https://www.youtube.com/embed/VIDEO_ID",
        "title": "YouTube video player",
        "width": "560",
    }
    assert not document.xpath(".//audio | .//video | .//source")
    assert not document.xpath(".//div[contains(@class, 'pl-media-player-controls')]")


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
        (
            '<pl-media-player file-name="clip.wav" allow-muting="sometimes"></pl-media-player>',
            "allow-muting",
        ),
        (
            '<pl-media-player source-directory="clips" randomize="true" '
            'media-type="audio" extensions="mp4"></pl-media-player>',
            "Unsupported extensions",
        ),
        (
            '<pl-media-player url="ftp://media.example.test/clip.mp3"></pl-media-player>',
            "absolute HTTP",
        ),
        (
            '<pl-media-player url="https://media.example.test/playback"></pl-media-player>',
            "Cannot infer the media type",
        ),
        (
            '<pl-media-player url="https://media.example.test/clip.mp4" '
            'media-type="audio"></pl-media-player>',
            "not audio media",
        ),
        (
            '<pl-media-player file-name="clip.wav" '
            'url="https://media.example.test/clip.wav"></pl-media-player>',
            "cannot be combined",
        ),
        (
            '<pl-media-player url="https://www.youtube.com/watch?v=VIDEO_ID" '
            'max-plays="2"></pl-media-player>',
            "YouTube url cannot be combined",
        ),
        (
            '<pl-media-player url="https://www.youtube.com/watch"></pl-media-player>',
            "YouTube url must identify a video",
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
        "allowMuting": False,
        "allowPause": False,
        "allowSeeking": False,
        "maxPlays": 2,
        "persist": True,
        "playerId": "prompt",
        "showRemaining": True,
        "variantId": "99",
    }


def test_playback_warning_is_red_and_inline_before_remaining_count(data):
    write_media(data, "clip.wav")
    html = (
        '<pl-media-player file-name="clip.wav" max-plays="1" '
        'allow-pause="false"></pl-media-player>'
    )

    prepare(html, data)
    document = media_player.lxml.html.fragment_fromstring(render(html, data))
    warning = document.xpath(
        ".//span[contains(concat(' ', normalize-space(@class), ' '), "
        "' pl-media-player-playback-warning ')]"
    )[0]
    remaining = document.xpath(
        ".//span[contains(concat(' ', normalize-space(@class), ' '), "
        "' pl-media-player-remaining ')]"
    )[0]

    assert "text-danger" in warning.classes
    assert "hidden" in warning.attrib
    assert warning.getparent() is remaining.getparent()
    assert warning.getnext() is remaining


def test_playback_count_is_restored_from_submission_and_excluded_from_answers(data):
    write_media(data, "clip.wav")
    html = (
        '<pl-media-player file-name="clip.wav" player-id="prompt" '
        'max-plays="2"></pl-media-player>'
    )
    count_name = f"{media_player.PLAYBACK_COUNT_NAME_PREFIX}prompt"
    data["raw_submitted_answers"] = {count_name: "1"}
    data["submitted_answers"] = {count_name: "1", "answer": "kept"}

    prepare(html, data)
    output = render(html, data)
    document = media_player.lxml.html.fragment_fromstring(output)
    count_input = document.xpath(
        ".//input[contains(@class, 'pl-media-player-playback-count')]"
    )[0]

    assert count_input.attrib == {
        "class": "pl-media-player-playback-count",
        "data-skip-unload-check": "true",
        "name": count_name,
        "type": "hidden",
        "value": "1",
    }

    parse(html, data)
    assert data["submitted_answers"] == {"answer": "kept"}
    assert data["raw_submitted_answers"] == {count_name: "1"}


@pytest.mark.parametrize(
    ("attributes", "expected"),
    [
        ("", True),
        ('max-plays="2"', False),
        ('max-plays="2" allow-muting="true"', True),
        ('allow-muting="false"', False),
    ],
)
def test_allow_muting_resolves_auto_and_explicit_values(data, attributes, expected):
    write_media(data, "clip.wav")
    html = f'<pl-media-player file-name="clip.wav" {attributes}></pl-media-player>'

    prepare(html, data)
    output = render(html, data)
    document = media_player.lxml.html.fragment_fromstring(output)
    config = json.loads(document.attrib["data-pl-media-player-config"])

    assert config["allowMuting"] is expected
