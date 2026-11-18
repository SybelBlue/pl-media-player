from __future__ import annotations

import hashlib
import itertools
import json
import re
from dataclasses import dataclass
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
    return pl.get_string_attrib(element, "player-id", f"auto-{instance_index + 1}")


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


def _parse_extensions(element: lxml.html.HtmlElement) -> frozenset[str] | None:
    raw = pl.get_string_attrib(element, "extensions", None)
    if raw is None:
        return None

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

    return frozenset(values)


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
    return pl.get_integer_attrib(element, "max-plays")


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


@dataclass(frozen=True, kw_only=True)
class Config:
    """Validated element configuration shared by prepare and render."""

    allow_muting: bool
    allow_pause: bool
    allow_seeking: bool
    directory: Directory
    extensions: frozenset[str] | None
    file_name: str | None
    max_plays: int | None
    media_type: MediaType
    persist: Persist
    player_id: str
    randomize: bool
    show_remaining: bool
    source_directory: str | None

    def __post_init__(self) -> None:
        if self.max_plays is not None and self.max_plays < 1:
            raise ValueError("max-plays must be at least 1 when provided.")
        if PLAYER_ID_PATTERN.fullmatch(self.player_id) is None:
            raise ValueError(
                "player-id must begin with a letter and contain only letters, digits, "
                "underscores, and hyphens."
            )

        if self.extensions is not None:
            if not self.extensions:
                raise ValueError("extensions must contain at least one entry.")
            unsupported = self.extensions - self.default_extensions
            if unsupported:
                joined = ", ".join(sorted(unsupported))
                raise ValueError(
                    f"Unsupported extensions for media-type={self.media_type.value}: "
                    f"{joined}."
                )

        if self.file_name is not None:
            if (
                self.source_directory is not None
                or self.randomize
                or self.extensions is not None
            ):
                raise ValueError(
                    "file-name cannot be combined with source-directory, randomize=true, "
                    "or extensions."
                )
            _relative_path(self.file_name, attribute="file-name")
            _infer_media_type(self.file_name, self.media_type)
        else:
            if not self.randomize or self.source_directory is None:
                raise ValueError(
                    "Provide file-name, or set both source-directory and randomize=true."
                )
            _relative_path(
                self.source_directory, attribute="source-directory", allow_dot=True
            )

    @classmethod
    def from_element(
        cls, element: lxml.html.HtmlElement, instance_index: int
    ) -> Config:
        pl.check_attribs(
            element, required_attribs=[], optional_attribs=OPTIONAL_ATTRIBUTES
        )
        directory = _directory(element)
        media_type = _media_type(element)
        max_plays = _max_plays(element)
        return cls(
            allow_muting=_allow_muting(element, max_plays),
            allow_pause=pl.get_boolean_attrib(element, "allow-pause", True),
            allow_seeking=pl.get_boolean_attrib(element, "allow-seeking", True),
            directory=directory,
            extensions=_parse_extensions(element),
            file_name=pl.get_string_attrib(element, "file-name", None),
            max_plays=max_plays,
            media_type=media_type,
            persist=_persist(element),
            player_id=_player_id(element, instance_index),
            randomize=pl.get_boolean_attrib(element, "randomize", False),
            show_remaining=pl.get_boolean_attrib(element, "show-remaining", True),
            source_directory=pl.get_string_attrib(element, "source-directory", None),
        )

    @property
    def default_extensions(self) -> frozenset[str]:
        if self.media_type is MediaType.AUDIO:
            return AUDIO_EXTENSIONS
        if self.media_type is MediaType.VIDEO:
            return VIDEO_EXTENSIONS
        return SUPPORTED_EXTENSIONS

    @property
    def discovery_extensions(self) -> frozenset[str]:
        return self.extensions or self.default_extensions

    def to_client_dict(self, variant_id: str) -> dict[str, bool | int | str | None]:
        return {
            "allowMuting": self.allow_muting,
            "allowPause": self.allow_pause,
            "allowSeeking": self.allow_seeking,
            "maxPlays": self.max_plays,
            "persist": self.persist is Persist.VARIANT,
            "playerId": self.player_id,
            "showRemaining": self.show_remaining,
            "variantId": variant_id,
        }


def _select_file(
    config: Config,
    data: pl.QuestionData,
) -> str:
    if config.file_name is not None:
        relative = _relative_path(config.file_name, attribute="file-name")
        path = _resolve_within(
            _root(data, config.directory), relative, attribute="file-name"
        )
        if not path.is_file():
            raise FileNotFoundError(
                f'File "{config.file_name}" not found in directory '
                f'"{config.directory.value}".'
            )
        return relative.as_posix()

    assert config.source_directory is not None
    relative_directory = _relative_path(
        config.source_directory, attribute="source-directory", allow_dot=True
    )
    root = _root(data, config.directory)
    discovery_path = _resolve_within(
        root, relative_directory, attribute="source-directory"
    )
    if not discovery_path.is_dir():
        raise FileNotFoundError(
            f'Directory "{config.source_directory}" not found in '
            f'"{config.directory.value}".'
        )

    extensions = config.discovery_extensions
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
            f"No supported media files found in "
            f'"{config.directory.value}/{config.source_directory}".'
        )

    seed = ":".join(
        [
            str(data["variant_seed"]),
            config.player_id,
            config.directory.value,
            config.source_directory,
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
    config = Config.from_element(element, instance_index)

    state = _state(data)
    if config.player_id in state:
        raise ValueError(
            f'Duplicate player-id "{config.player_id}". '
            "Each pl-media-player needs a unique identity."
        )

    file_name = _select_file(config, data)
    resolved_media_type = _infer_media_type(file_name, config.media_type)
    state[config.player_id] = {
        "directory": config.directory.value,
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
    config = Config.from_element(element, instance_index)
    state = data["params"].get(PARAMS_KEY, {})
    if not isinstance(state, dict) or config.player_id not in state:
        raise ValueError(
            f'No prepared media selection exists for player-id "{config.player_id}". '
            "Regenerate the question variant."
        )
    selection = state[config.player_id]
    directory = Directory(selection["directory"])
    file_name = selection["file_name"]
    media_type = MediaType(selection["media_type"])

    base_url = str(data["options"][DIRECTORY_URL_OPTIONS[directory]]).rstrip("/")
    src = f"{base_url}/{_url_path(file_name)}"
    dom_id = pl.get_uuid()
    variant_id = str(data["options"].get("variant_id", data["variant_seed"]))
    client_config = config.to_client_dict(variant_id)

    params = {
        "audio": media_type is MediaType.AUDIO,
        "config_json": json.dumps(client_config, separators=(",", ":")),
        "dom_id": dom_id,
        "file_name": file_name,
        "mime_type": MIME_TYPES[PurePosixPath(file_name).suffix.lower()],
        "show_remaining": config.show_remaining,
        "src": src,
        "video": media_type is MediaType.VIDEO,
    }
    template = (
        Path(__file__).with_name("pl-media-player.mustache").read_text(encoding="utf-8")
    )
    return chevron.render(template, params).strip()


def render(element_html: str, data: pl.QuestionData) -> str:
    return _render_with_index(element_html, data, next(_render_indices))
