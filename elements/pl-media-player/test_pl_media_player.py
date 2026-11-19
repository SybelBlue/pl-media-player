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


def prepare(html: str, data) -> None:
    media_player.prepare(html, data)


def render(html: str, data) -> str:
    return media_player.render(html, data)


def parse(html: str, data) -> None:
    media_player.parse(html, data)


def test_config_is_frozen_portable_and_validated():
    element = media_player._element(
        '<pl-media-player file-name="clip.wav" max-plays="2" '
        'player-id="main"></pl-media-player>'
    )

    config = media_player.Config.from_element(element)

    assert config.to_client_dict("variant-1") == {
        "allowMuting": False,
        "allowOverlappingPlayback": False,
        "allowPause": True,
        "allowSeeking": True,
        "maxPlays": 2,
        "playerId": "main",
        "showRemaining": True,
        "variantId": "variant-1",
    }
    with pytest.raises(FrozenInstanceError):
        config.max_plays = 3


def test_explicit_question_file_is_resolved_and_rendered(data):
    write_media(data, "clips/hello.wav")
    html = '<pl-media-player file-name="clips/hello.wav" player-id="hello"></pl-media-player>'

    prepare(html, data)
    output = render(html, data)

    assert (
        data["params"][media_player.PARAMS_KEY]["hello"]["file_name"]
        == "clips/hello.wav"
    )
    assert 'src="/q/7/clientFilesQuestion/clips/hello.wav"' in output
    document = media_player.lxml.html.fragment_fromstring(output)
    audio = document.xpath(".//audio")[0]
    assert audio.attrib["controlslist"] == "nodownload"


def test_external_url_is_preserved_and_rendered(data):
    html = (
        '<pl-media-player url="https://cdn.example.test/media/clip.mp3?token=a%20b&amp;v=2" '
        'player-id="external">'
        "</pl-media-player>"
    )

    prepare(html, data)
    output = render(html, data)
    document = media_player.lxml.html.fragment_fromstring(output)
    source = document.xpath(".//source")[0]

    assert data["params"][media_player.PARAMS_KEY]["external"] == {
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
        'media-type="video" player-id="stream"></pl-media-player>'
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
    html = f'<pl-media-player url="{url}" player-id="youtube"></pl-media-player>'

    prepare(html, data)
    output = render(html, data)
    document = media_player.lxml.html.fragment_fromstring(output)
    iframe = document.xpath(".//iframe")[0]

    assert data["params"][media_player.PARAMS_KEY]["youtube"] == {
        "youtube_embed_url": "https://www.youtube.com/embed/VIDEO_ID"
    }
    assert iframe.attrib == {
        "allow": "accelerometer; autoplay; clipboard-write; encrypted-media; "
        "gyroscope; picture-in-picture; web-share",
        "allowfullscreen": "",
        "class": "pl-media-player-youtube d-block h-auto mx-auto w-100",
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
        'media-type="audio" extensions="wav, mp3" player-id="discovery"></pl-media-player>'
    )

    prepare(html, data)
    selected = data["params"][media_player.PARAMS_KEY]["discovery"]["file_name"]
    write_media(data, "clips/new.wav")
    output = render(html, data)

    assert selected in {"clips/a.wav", "clips/b.mp3"}
    assert f"/q/7/clientFilesQuestion/{selected}" in output


def test_random_selection_changes_with_variant_seed(data):
    for index in range(10):
        write_media(data, f"clips/{index}.wav")
    html = (
        '<pl-media-player source-directory="clips" randomize="true" '
        'player-id="random"></pl-media-player>'
    )

    selected = set()
    for seed in range(20):
        variant = {**data, "params": {}, "variant_seed": seed}
        prepare(html, variant)
        selected.add(variant["params"][media_player.PARAMS_KEY]["random"]["file_name"])

    assert len(selected) > 1


def test_multiple_instances_have_independent_selections_and_ids(data):
    for index in range(8):
        write_media(data, f"clips/{index}.wav")
    first_html = (
        '<pl-media-player source-directory="clips" randomize="true" '
        'player-id="first"></pl-media-player>'
    )
    second_html = (
        '<pl-media-player source-directory="clips" randomize="true" '
        'player-id="second"></pl-media-player>'
    )

    prepare(first_html, data)
    prepare(second_html, data)

    state = data["params"][media_player.PARAMS_KEY]
    assert set(state) == {"first", "second"}
    assert state["first"]["file_name"] != state["second"]["file_name"]


def test_empty_or_missing_discovery_directory_has_clear_error(data):
    Path(data["options"]["client_files_question_path"], "empty").mkdir()

    with pytest.raises(ValueError, match="No supported media files"):
        prepare(
            '<pl-media-player source-directory="empty" randomize="true" '
            'player-id="empty"></pl-media-player>',
            data,
        )
    with pytest.raises(FileNotFoundError, match="Directory .* not found"):
        prepare(
            '<pl-media-player source-directory="missing" randomize="true" '
            'player-id="missing"></pl-media-player>',
            {**data, "params": {}},
        )


def test_missing_file_and_path_traversal_are_rejected(data):
    with pytest.raises(FileNotFoundError, match="not found"):
        prepare(
            '<pl-media-player file-name="missing.wav" player-id="missing"></pl-media-player>',
            data,
        )

    for path in ("../secret.wav", "/absolute.wav", "nested/../../secret.wav"):
        with pytest.raises(ValueError, match="stay inside"):
            prepare(
                f'<pl-media-player file-name="{path}" player-id="path"></pl-media-player>',
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
            '<pl-media-player source-directory="clips" randomize="true" '
            'player-id="escape"></pl-media-player>',
            data,
        )


@pytest.mark.parametrize(
    ("html", "message"),
    [
        (
            '<pl-media-player file-name="clip.wav"></pl-media-player>',
            "player-id",
        ),
        (
            '<pl-media-player player-id="main"></pl-media-player>',
            "Provide file-name",
        ),
        (
            '<pl-media-player file-name="clip.wav" randomize="true" '
            'player-id="main"></pl-media-player>',
            "cannot be combined",
        ),
        (
            '<pl-media-player source-directory="clips" randomize="false" '
            'player-id="main"></pl-media-player>',
            "Provide file-name",
        ),
        (
            '<pl-media-player file-name="clip.wav" max-plays="0" '
            'player-id="main"></pl-media-player>',
            "at least 1",
        ),
        (
            '<pl-media-player file-name="clip.wav" player-id="not valid"></pl-media-player>',
            "player-id",
        ),
        (
            '<pl-media-player file-name="clip.wav" allow-muting="sometimes" '
            'player-id="main"></pl-media-player>',
            "allow-muting",
        ),
        (
            '<pl-media-player file-name="clip.wav" '
            'allow-overlapping-playback="sometimes" player-id="main"></pl-media-player>',
            "allow-overlapping-playback",
        ),
        (
            '<pl-media-player source-directory="clips" randomize="true" '
            'media-type="audio" extensions="mp4" player-id="main"></pl-media-player>',
            "Unsupported extensions",
        ),
        (
            '<pl-media-player url="ftp://media.example.test/clip.mp3" '
            'player-id="main"></pl-media-player>',
            "absolute HTTP",
        ),
        (
            '<pl-media-player url="https://media.example.test/playback" '
            'player-id="main"></pl-media-player>',
            "Cannot infer the media type",
        ),
        (
            '<pl-media-player url="https://media.example.test/clip.mp4" '
            'media-type="audio" player-id="main"></pl-media-player>',
            "not audio media",
        ),
        (
            '<pl-media-player file-name="clip.wav" '
            'url="https://media.example.test/clip.wav" '
            'player-id="main"></pl-media-player>',
            "cannot be combined",
        ),
        (
            '<pl-media-player url="https://www.youtube.com/watch?v=VIDEO_ID" '
            'max-plays="2" player-id="main"></pl-media-player>',
            "YouTube url cannot be combined",
        ),
        (
            '<pl-media-player url="https://www.youtube.com/watch" '
            'player-id="main"></pl-media-player>',
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

    prepare(html, data)
    with pytest.raises(ValueError, match="Duplicate player-id"):
        prepare(html, data)


def test_render_configuration_uses_variant_and_stable_player_identity(data):
    write_media(data, "folder name/clip.wav")
    html = (
        '<pl-media-player file-name="folder name/clip.wav" player-id="prompt" '
        'max-plays="2" allow-pause="false" allow-seeking="false" '
        'allow-overlapping-playback="true"></pl-media-player>'
    )

    prepare(html, data)
    output = render(html, data)
    document = media_player.lxml.html.fragment_fromstring(output)
    config = json.loads(document.attrib["data-pl-media-player-config"])

    assert "folder%20name/clip.wav" in output
    assert config == {
        "allowMuting": False,
        "allowOverlappingPlayback": True,
        "allowPause": False,
        "allowSeeking": False,
        "maxPlays": 2,
        "playerId": "prompt",
        "showRemaining": True,
        "variantId": "99",
    }


def test_player_messages_share_one_line_below_the_controls(data):
    write_media(data, "clip.wav")
    html = (
        '<pl-media-player file-name="clip.wav" max-plays="1" '
        'allow-pause="false" player-id="messages"></pl-media-player>'
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
    status = document.xpath(
        ".//span[contains(concat(' ', normalize-space(@class), ' '), "
        "' pl-media-player-status ')]"
    )[0]
    message_line = warning.getparent()

    assert "text-danger" in warning.classes
    assert "hidden" in warning.attrib
    assert "text-nowrap" in message_line.classes
    assert message_line is remaining.getparent()
    assert message_line is status.getparent()
    assert "pl-media-player-controls" in message_line.getprevious().classes
    assert warning.getnext() is remaining
    assert remaining.getnext() is status


def test_video_and_controls_render_as_one_continuous_frame(data):
    write_media(data, "clip.mp4")
    html = '<pl-media-player file-name="clip.mp4" player-id="video"></pl-media-player>'

    prepare(html, data)
    document = media_player.lxml.html.fragment_fromstring(render(html, data))
    video = document.xpath(".//video")[0]
    controls = document.xpath(".//div[contains(@class, 'pl-media-player-controls')]")[0]

    assert {"border", "rounded-top"}.issubset(video.classes)
    assert {"border-top-0", "rounded-bottom"}.issubset(controls.classes)
    assert "rounded" not in controls.classes


def test_media_buttons_render_accessible_svg_icons(data):
    write_media(data, "clip.wav")
    html = '<pl-media-player file-name="clip.wav" player-id="icons"></pl-media-player>'

    prepare(html, data)
    document = media_player.lxml.html.fragment_fromstring(render(html, data))
    play_button = document.xpath(".//button[contains(@class, 'pl-media-player-play')]")[
        0
    ]
    mute_button = document.xpath(".//button[contains(@class, 'pl-media-player-mute')]")[
        0
    ]

    assert play_button.text_content().strip() == ""
    assert play_button.attrib["aria-label"] == "Play"
    assert play_button.attrib["data-icon"] == "play"
    assert {icon.attrib["class"] for icon in play_button.xpath("./svg")} == {
        "pl-media-player-icon pl-media-player-icon-play",
        "pl-media-player-icon pl-media-player-icon-pause",
    }

    assert mute_button.text_content().strip() == ""
    assert mute_button.attrib["aria-label"] == "Mute"
    assert mute_button.attrib["data-icon"] == "volume"
    assert {icon.attrib["class"] for icon in mute_button.xpath("./svg")} == {
        "pl-media-player-icon pl-media-player-icon-volume",
        "pl-media-player-icon pl-media-player-icon-muted",
    }

    for icon in play_button.xpath("./svg") + mute_button.xpath("./svg"):
        assert icon.attrib["aria-hidden"] == "true"
        assert icon.attrib["focusable"] == "false"


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
    html = (
        f'<pl-media-player file-name="clip.wav" player-id="muting" '
        f"{attributes}></pl-media-player>"
    )

    prepare(html, data)
    output = render(html, data)
    document = media_player.lxml.html.fragment_fromstring(output)
    config = json.loads(document.attrib["data-pl-media-player-config"])

    assert config["allowMuting"] is expected
