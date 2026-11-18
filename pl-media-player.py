from __future__ import annotations

import hashlib
import itertools
import json
import re
from enum import Enum
from pathlib import Path, PurePosixPath
from urllib.parse import quote

import chevron
import lxml.html
import prairielearn as pl


class Directory(Enum):
    CLIENT_FILES_QUESTION = "clientFilesQuestion"
    CLIENT_FILES_COURSE = "clientFilesCourse"


class MediaType(Enum):
    AUTO = "auto"
    AUDIO = "audio"
    VIDEO = "video"


class Persist(Enum):
    NONE = "none"
    VARIANT = "variant"


DIRECTORY_PATH_OPTIONS = {
    Directory.CLIENT_FILES_QUESTION: "client_files_question_path",
    Directory.CLIENT_FILES_COURSE: "client_files_course_path",
}

DIRECTORY_URL_OPTIONS = {
    Directory.CLIENT_FILES_QUESTION: "client_files_question_url",
    Directory.CLIENT_FILES_COURSE: "client_files_course_url",
}

AUDIO_EXTENSIONS = frozenset({".aac", ".flac", ".m4a", ".mp3", ".oga", ".ogg", ".wav"})
VIDEO_EXTENSIONS = frozenset({".m4v", ".mov", ".mp4", ".ogv", ".webm"})
SUPPORTED_EXTENSIONS = AUDIO_EXTENSIONS | VIDEO_EXTENSIONS

MIME_TYPES = {
    ".aac": "audio/aac",
    ".flac": "audio/flac",
    ".m4a": "audio/mp4",
    ".mp3": "audio/mpeg",
    ".oga": "audio/ogg",
    ".ogg": "audio/ogg",
    ".wav": "audio/wav",
    ".m4v": "video/mp4",
    ".mov": "video/quicktime",
    ".mp4": "video/mp4",
    ".ogv": "video/ogg",
    ".webm": "video/webm",
}

PARAMS_KEY = "_pl_media_player"
PLAYER_ID_PATTERN = re.compile(r"^[A-Za-z][A-Za-z0-9_-]*$")
OPTIONAL_ATTRIBUTES = [
    "allow-muting",
    "allow-pause",
    "allow-seeking",
    "directory",
    "extensions",
    "file-name",
    "max-plays",
    "media-type",
    "persist",
    "player-id",
    "randomize",
    "show-remaining",
    "source-directory",
]

# PrairieLearn loads a fresh controller module for each lifecycle phase and invokes
# element instances in document order. Separate counters therefore produce the same
# stable automatic identity during prepare and render.
_prepare_indices = itertools.count()
_render_indices = itertools.count()


def _element(element_html: str | bytes) -> lxml.html.HtmlElement:
    return lxml.html.fragment_fromstring(element_html)


def _directory(element: lxml.html.HtmlElement) -> Directory:
    value = pl.get_string_attrib(
        element, "directory", Directory.CLIENT_FILES_QUESTION.value
    )
    try:
        return Directory(value)
    except ValueError as exc:
        choices = ", ".join(item.value for item in Directory)
        raise ValueError(
            f'Invalid directory "{value}"; expected one of: {choices}.'
        ) from exc


def _media_type(element: lxml.html.HtmlElement) -> MediaType:
    value = pl.get_string_attrib(element, "media-type", MediaType.AUTO.value)
    try:
        return MediaType(value)
    except ValueError as exc:
        choices = ", ".join(item.value for item in MediaType)
        raise ValueError(
            f'Invalid media-type "{value}"; expected one of: {choices}.'
        ) from exc


def _persist(element: lxml.html.HtmlElement) -> Persist:
    value = pl.get_string_attrib(element, "persist", Persist.NONE.value)
    try:
        return Persist(value)
    except ValueError as exc:
        choices = ", ".join(item.value for item in Persist)
        raise ValueError(
            f'Invalid persist value "{value}"; expected one of: {choices}.'
        ) from exc


def _player_id(element: lxml.html.HtmlElement, instance_index: int) -> str:
    value = pl.get_string_attrib(element, "player-id", f"auto-{instance_index + 1}")
    if PLAYER_ID_PATTERN.fullmatch(value) is None:
        raise ValueError(
            "player-id must begin with a letter and contain only letters, digits, "
            "underscores, and hyphens."
        )
    return value


def _relative_path(
    value: str, *, attribute: str, allow_dot: bool = False
) -> PurePosixPath:
    if not value or "\\" in value or "\0" in value:
        raise ValueError(f"{attribute} must be a nonempty POSIX relative path.")
    path = PurePosixPath(value)
    if path.is_absolute() or ".." in path.parts:
        raise ValueError(
            f"{attribute} must stay inside the selected client-files directory."
        )
    if value != path.as_posix() or (not allow_dot and value == "."):
        raise ValueError(f"{attribute} must be a normalized POSIX relative path.")
    return path


def _root(data: pl.QuestionData, directory: Directory) -> Path:
    return Path(data["options"][DIRECTORY_PATH_OPTIONS[directory]]).resolve()


def _resolve_within(root: Path, relative: PurePosixPath, *, attribute: str) -> Path:
    candidate = root.joinpath(*relative.parts).resolve()
    try:
        candidate.relative_to(root)
    except ValueError as exc:
        raise ValueError(
            f"{attribute} resolves outside the selected client-files directory."
        ) from exc
    return candidate


def _extension_set(
    element: lxml.html.HtmlElement, media_type: MediaType
) -> frozenset[str]:
    if media_type is MediaType.AUDIO:
        allowed = AUDIO_EXTENSIONS
    elif media_type is MediaType.VIDEO:
        allowed = VIDEO_EXTENSIONS
    else:
        allowed = SUPPORTED_EXTENSIONS

    raw = pl.get_string_attrib(element, "extensions", None)
    if raw is None:
        return allowed

    values = []
    for item in raw.split(","):
        extension = item.strip().lower()
        if not extension:
            raise ValueError(
                "extensions must be a comma-separated list without empty entries."
            )
        if not extension.startswith("."):
            extension = f".{extension}"
        values.append(extension)

    requested = frozenset(values)
    unsupported = requested - allowed
    if unsupported:
        joined = ", ".join(sorted(unsupported))
        raise ValueError(
            f"Unsupported extensions for media-type={media_type.value}: {joined}."
        )
    return requested


def _infer_media_type(file_name: str, requested: MediaType) -> MediaType:
    extension = PurePosixPath(file_name).suffix.lower()
    if extension not in SUPPORTED_EXTENSIONS:
        raise ValueError(
            f'Unsupported media extension "{extension or "(none)"}" in file-name "{file_name}".'
        )
    inferred = MediaType.AUDIO if extension in AUDIO_EXTENSIONS else MediaType.VIDEO
    if requested is not MediaType.AUTO and requested is not inferred:
        raise ValueError(
            f'file-name "{file_name}" is {inferred.value} media, not {requested.value} media.'
        )
    return inferred


def _max_plays(element: lxml.html.HtmlElement) -> int | None:
    if not pl.has_attrib(element, "max-plays"):
        return None
    value = pl.get_integer_attrib(element, "max-plays")
    if value < 1:
        raise ValueError("max-plays must be at least 1 when provided.")
    return value


def _allow_muting(element: lxml.html.HtmlElement, max_plays: int | None) -> bool:
    value = pl.get_string_attrib(element, "allow-muting", "auto")
    if value == "auto":
        return max_plays is None
    if value == "true":
        return True
    if value == "false":
        return False
    raise ValueError(
        f'Invalid allow-muting value "{value}"; expected one of: auto, true, false.'
    )


def _select_file(
    element: lxml.html.HtmlElement,
    data: pl.QuestionData,
    *,
    directory: Directory,
    media_type: MediaType,
    player_id: str,
) -> str:
    file_name = pl.get_string_attrib(element, "file-name", None)
    source_directory = pl.get_string_attrib(element, "source-directory", None)
    randomize = pl.get_boolean_attrib(element, "randomize", False)
    has_extensions = pl.has_attrib(element, "extensions")

    if file_name is not None:
        if source_directory is not None or randomize or has_extensions:
            raise ValueError(
                "file-name cannot be combined with source-directory, randomize=true, "
                "or extensions."
            )
        relative = _relative_path(file_name, attribute="file-name")
        path = _resolve_within(_root(data, directory), relative, attribute="file-name")
        if not path.is_file():
            raise FileNotFoundError(
                f'File "{file_name}" not found in directory "{directory.value}".'
            )
        _infer_media_type(file_name, media_type)
        return relative.as_posix()

    if not randomize or source_directory is None:
        raise ValueError(
            "Provide file-name, or set both source-directory and randomize=true."
        )

    relative_directory = _relative_path(
        source_directory, attribute="source-directory", allow_dot=True
    )
    root = _root(data, directory)
    discovery_path = _resolve_within(
        root, relative_directory, attribute="source-directory"
    )
    if not discovery_path.is_dir():
        raise FileNotFoundError(
            f'Directory "{source_directory}" not found in "{directory.value}".'
        )

    extensions = _extension_set(element, media_type)
    candidates = []
    for path in discovery_path.iterdir():
        if not path.is_file() or path.suffix.lower() not in extensions:
            continue
        try:
            path.resolve().relative_to(root)
        except ValueError as exc:
            raise ValueError(
                f'Discovered file "{path.name}" resolves outside the selected '
                "client-files directory."
            ) from exc
        candidates.append(path.relative_to(root).as_posix())
    candidates.sort()
    if not candidates:
        raise ValueError(
            f'No supported media files found in "{directory.value}/{source_directory}".'
        )

    seed = ":".join(
        [
            str(data["variant_seed"]),
            player_id,
            directory.value,
            source_directory,
            *candidates,
        ]
    )
    digest = hashlib.sha256(seed.encode()).digest()
    return candidates[int.from_bytes(digest[:8], "big") % len(candidates)]


def _state(data: pl.QuestionData) -> dict[str, dict[str, str]]:
    value = data["params"].setdefault(PARAMS_KEY, {})
    if not isinstance(value, dict):
        raise TypeError(f'data["params"]["{PARAMS_KEY}"] must be an object.')
    return value


def _prepare_with_index(
    element_html: str | bytes, data: pl.QuestionData, instance_index: int
) -> None:
    element = _element(element_html)
    pl.check_attribs(element, required_attribs=[], optional_attribs=OPTIONAL_ATTRIBUTES)

    directory = _directory(element)
    requested_media_type = _media_type(element)
    _persist(element)
    max_plays = _max_plays(element)
    _allow_muting(element, max_plays)
    pl.get_boolean_attrib(element, "allow-pause", True)
    pl.get_boolean_attrib(element, "allow-seeking", True)
    pl.get_boolean_attrib(element, "show-remaining", True)
    player_id = _player_id(element, instance_index)

    state = _state(data)
    if player_id in state:
        raise ValueError(
            f'Duplicate player-id "{player_id}". Each pl-media-player needs a unique identity.'
        )

    file_name = _select_file(
        element,
        data,
        directory=directory,
        media_type=requested_media_type,
        player_id=player_id,
    )
    resolved_media_type = _infer_media_type(file_name, requested_media_type)
    state[player_id] = {
        "directory": directory.value,
        "file_name": file_name,
        "media_type": resolved_media_type.value,
    }


def prepare(element_html: str, data: pl.QuestionData) -> None:
    _prepare_with_index(element_html, data, next(_prepare_indices))


def _url_path(file_name: str) -> str:
    return "/".join(quote(part, safe="") for part in PurePosixPath(file_name).parts)


def _render_with_index(
    element_html: str | bytes, data: pl.QuestionData, instance_index: int
) -> str:
    element = _element(element_html)
    player_id = _player_id(element, instance_index)
    state = data["params"].get(PARAMS_KEY, {})
    if not isinstance(state, dict) or player_id not in state:
        raise ValueError(
            f'No prepared media selection exists for player-id "{player_id}". '
            "Regenerate the question variant."
        )
    selection = state[player_id]
    directory = Directory(selection["directory"])
    file_name = selection["file_name"]
    media_type = MediaType(selection["media_type"])

    base_url = str(data["options"][DIRECTORY_URL_OPTIONS[directory]]).rstrip("/")
    src = f"{base_url}/{_url_path(file_name)}"
    max_plays = _max_plays(element)
    show_remaining = pl.get_boolean_attrib(element, "show-remaining", True)
    dom_id = pl.get_uuid()
    config = {
        "allowMuting": _allow_muting(element, max_plays),
        "allowPause": pl.get_boolean_attrib(element, "allow-pause", True),
        "allowSeeking": pl.get_boolean_attrib(element, "allow-seeking", True),
        "maxPlays": max_plays,
        "persist": _persist(element) is Persist.VARIANT,
        "playerId": player_id,
        "showRemaining": show_remaining,
        "variantId": str(data["options"].get("variant_id", data["variant_seed"])),
    }

    params = {
        "audio": media_type is MediaType.AUDIO,
        "config_json": json.dumps(config, separators=(",", ":")),
        "dom_id": dom_id,
        "file_name": file_name,
        "mime_type": MIME_TYPES[PurePosixPath(file_name).suffix.lower()],
        "show_remaining": show_remaining,
        "src": src,
        "video": media_type is MediaType.VIDEO,
    }
    template = (
        Path(__file__).with_name("pl-media-player.mustache").read_text(encoding="utf-8")
    )
    return chevron.render(template, params).strip()


def render(element_html: str, data: pl.QuestionData) -> str:
    return _render_with_index(element_html, data, next(_render_indices))
