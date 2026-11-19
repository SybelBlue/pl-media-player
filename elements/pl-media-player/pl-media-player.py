from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from enum import Enum
from pathlib import Path, PurePosixPath
from urllib.parse import parse_qs, quote, unquote, urlsplit

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
PLAYBACK_COUNT_NAME_PREFIX = "_pl_media_player_plays_"
PLAYER_ID_PATTERN = re.compile(r"^[A-Za-z][A-Za-z0-9_-]*$")
YOUTUBE_VIDEO_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]+$")
OPTIONAL_ATTRIBUTES = [
    "allow-muting",
    "allow-overlapping-playback",
    "allow-pause",
    "allow-seeking",
    "directory",
    "extensions",
    "file-name",
    "max-plays",
    "media-type",
    "randomize",
    "show-remaining",
    "source-directory",
    "url",
]


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


def _player_id(element: lxml.html.HtmlElement) -> str:
    return pl.get_string_attrib(element, "player-id")


def _playback_count_name(player_id: str) -> str:
    return f"{PLAYBACK_COUNT_NAME_PREFIX}{player_id}"


def _submitted_playback_count(data: pl.QuestionData, player_id: str) -> int:
    raw_submitted_answers = data.get("raw_submitted_answers", {})
    if not isinstance(raw_submitted_answers, dict):
        return 0
    value = raw_submitted_answers.get(_playback_count_name(player_id))
    if not isinstance(value, str) or re.fullmatch(r"\d+", value) is None:
        return 0
    return int(value)


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


def _validate_url(url: str) -> None:
    if not url or any(character.isspace() for character in url) or "\0" in url:
        raise ValueError("url must be a nonempty, properly escaped HTTP(S) URL.")

    try:
        parsed = urlsplit(url)
        hostname = parsed.hostname
    except ValueError as exc:
        raise ValueError("url must be a valid absolute HTTP(S) URL.") from exc
    if parsed.scheme not in {"http", "https"} or hostname is None:
        raise ValueError("url must be a valid absolute HTTP(S) URL.")


def _url_extension(url: str) -> str:
    return PurePosixPath(unquote(urlsplit(url).path)).suffix.lower()


def _youtube_embed_url(url: str) -> str | None:
    parsed = urlsplit(url)
    hostname = parsed.hostname
    if hostname is None:
        return None
    hostname = hostname.lower()
    youtube_host = hostname == "youtube.com" or hostname.endswith(".youtube.com")
    youtube_host = youtube_host or hostname == "youtube-nocookie.com"
    youtube_host = youtube_host or hostname.endswith(".youtube-nocookie.com")
    short_host = hostname == "youtu.be" or hostname.endswith(".youtu.be")
    if not youtube_host and not short_host:
        return None

    parts = [part for part in parsed.path.split("/") if part]
    video_id = None
    if short_host and parts:
        video_id = parts[0]
    elif youtube_host:
        if parsed.path.rstrip("/") == "/watch":
            video_id = next(iter(parse_qs(parsed.query).get("v", [])), None)
        elif len(parts) >= 2 and parts[0] in {"embed", "live", "shorts", "v"}:
            video_id = parts[1]

    if video_id is None or YOUTUBE_VIDEO_ID_PATTERN.fullmatch(video_id) is None:
        raise ValueError(
            "YouTube url must identify a video using a watch, share, shorts, live, "
            "or embed URL."
        )
    return f"https://www.youtube.com/embed/{video_id}"


def _infer_url_media_type(url: str, requested: MediaType) -> MediaType:
    extension = _url_extension(url)
    if extension in SUPPORTED_EXTENSIONS:
        inferred = MediaType.AUDIO if extension in AUDIO_EXTENSIONS else MediaType.VIDEO
        if requested is not MediaType.AUTO and requested is not inferred:
            raise ValueError(
                f'url "{url}" is {inferred.value} media, not {requested.value} media.'
            )
        return inferred
    if requested is MediaType.AUTO:
        raise ValueError(
            f'Cannot infer the media type from url "{url}"; set media-type to audio '
            "or video."
        )
    return requested


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


@dataclass(frozen=True, kw_only=True, slots=True)
class Config:
    """Validated element configuration shared by prepare and render."""

    allow_muting: bool
    allow_overlapping_playback: bool
    allow_pause: bool
    allow_seeking: bool
    directory: Directory
    extensions: frozenset[str] | None
    file_name: str | None
    max_plays: int | None
    media_type: MediaType
    player_id: str
    randomize: bool
    show_remaining: bool
    source_directory: str | None
    url: str | None

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
                or self.url is not None
                or self.randomize
                or self.extensions is not None
            ):
                raise ValueError(
                    "file-name cannot be combined with url, source-directory, "
                    "randomize=true, or extensions."
                )
            _relative_path(self.file_name, attribute="file-name")
            _infer_media_type(self.file_name, self.media_type)
        elif self.url is not None:
            if (
                self.source_directory is not None
                or self.randomize
                or self.extensions is not None
            ):
                raise ValueError(
                    "url cannot be combined with source-directory, randomize=true, "
                    "or extensions."
                )
            _validate_url(self.url)
            if _youtube_embed_url(self.url) is None:
                _infer_url_media_type(self.url, self.media_type)
        else:
            if not self.randomize or self.source_directory is None:
                raise ValueError(
                    "Provide file-name or url, or set both source-directory and "
                    "randomize=true."
                )
            _relative_path(
                self.source_directory, attribute="source-directory", allow_dot=True
            )

    @classmethod
    def from_element(cls, element: lxml.html.HtmlElement) -> Config:
        pl.check_attribs(
            element,
            required_attribs=["player-id"],
            optional_attribs=OPTIONAL_ATTRIBUTES,
        )
        url = pl.get_string_attrib(element, "url", None)
        if url is not None:
            _validate_url(url)
            if _youtube_embed_url(url) is not None:
                conflicts = [
                    attribute
                    for attribute in OPTIONAL_ATTRIBUTES
                    if attribute != "url" and pl.has_attrib(element, attribute)
                ]
                if conflicts:
                    raise ValueError(
                        "A YouTube url cannot be combined with other attributes: "
                        f"{', '.join(conflicts)}."
                    )

        directory = _directory(element)
        media_type = _media_type(element)
        max_plays = _max_plays(element)
        return cls(
            allow_muting=_allow_muting(element, max_plays),
            allow_overlapping_playback=pl.get_boolean_attrib(
                element, "allow-overlapping-playback", False
            ),
            allow_pause=pl.get_boolean_attrib(element, "allow-pause", True),
            allow_seeking=pl.get_boolean_attrib(element, "allow-seeking", True),
            directory=directory,
            extensions=_parse_extensions(element),
            file_name=pl.get_string_attrib(element, "file-name", None),
            max_plays=max_plays,
            media_type=media_type,
            player_id=_player_id(element),
            randomize=pl.get_boolean_attrib(element, "randomize", False),
            show_remaining=pl.get_boolean_attrib(element, "show-remaining", True),
            source_directory=pl.get_string_attrib(element, "source-directory", None),
            url=url,
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
            "allowOverlappingPlayback": self.allow_overlapping_playback,
            "allowPause": self.allow_pause,
            "allowSeeking": self.allow_seeking,
            "maxPlays": self.max_plays,
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


def prepare(element_html: str, data: pl.QuestionData) -> None:
    element = _element(element_html)
    config = Config.from_element(element)

    state = _state(data)
    if config.player_id in state:
        raise ValueError(
            f'Duplicate player-id "{config.player_id}". '
            "Each pl-media-player needs a unique identity."
        )

    if config.url is not None:
        youtube_embed_url = _youtube_embed_url(config.url)
        if youtube_embed_url is not None:
            state[config.player_id] = {"youtube_embed_url": youtube_embed_url}
        else:
            state[config.player_id] = {
                "media_type": _infer_url_media_type(
                    config.url, config.media_type
                ).value,
                "url": config.url,
            }
    else:
        file_name = _select_file(config, data)
        resolved_media_type = _infer_media_type(file_name, config.media_type)
        state[config.player_id] = {
            "directory": config.directory.value,
            "file_name": file_name,
            "media_type": resolved_media_type.value,
        }


def parse(element_html: str, data: pl.QuestionData) -> None:
    element = _element(element_html)
    config = Config.from_element(element)
    # Preserve the count in raw submission metadata without exposing it as a
    # gradable answer.
    data["submitted_answers"].pop(_playback_count_name(config.player_id), None)


def _url_path(file_name: str) -> str:
    return "/".join(quote(part, safe="") for part in PurePosixPath(file_name).parts)


def render(element_html: str, data: pl.QuestionData) -> str:
    if data["panel"] != "question":
        return ""

    element = _element(element_html)
    config = Config.from_element(element)
    state = data["params"].get(PARAMS_KEY, {})
    if not isinstance(state, dict) or config.player_id not in state:
        raise ValueError(
            f'No prepared media selection exists for player-id "{config.player_id}". '
            "Regenerate the question variant."
        )
    selection = state[config.player_id]
    youtube = "youtube_embed_url" in selection
    media_type = None
    extension = ""
    if youtube:
        src = selection["youtube_embed_url"]
    else:
        media_type = MediaType(selection["media_type"])
        if "url" in selection:
            src = selection["url"]
            extension = _url_extension(src)
        else:
            directory = Directory(selection["directory"])
            file_name = selection["file_name"]
            base_url = str(data["options"][DIRECTORY_URL_OPTIONS[directory]]).rstrip(
                "/"
            )
            src = f"{base_url}/{_url_path(file_name)}"
            extension = PurePosixPath(file_name).suffix.lower()
    dom_id = pl.get_uuid()
    variant_id = str(data["options"].get("variant_id", data["variant_seed"]))
    client_config = config.to_client_dict(variant_id)
    client_config["externalAudio"] = (
        media_type is MediaType.AUDIO and "url" in selection
    )
    if data["manual_grading"]:
        client_config.update(
            {
                "allowMuting": True,
                "allowOverlappingPlayback": True,
                "allowPause": True,
                "allowSeeking": True,
                "maxPlays": None,
                "showRemaining": False,
            }
        )

    plays_used = _submitted_playback_count(data, config.player_id)
    params = {
        "audio": media_type is MediaType.AUDIO,
        "config_json": json.dumps(client_config, separators=(",", ":")),
        "dom_id": dom_id,
        "grading_play_count": (
            f"Student played this media {plays_used} "
            f"{'time' if plays_used == 1 else 'times'}."
            if data["manual_grading"] and not youtube
            else None
        ),
        "limited_playback": client_config["maxPlays"] is not None,
        "mime_type": MIME_TYPES.get(extension),
        "playback_count_name": _playback_count_name(config.player_id),
        "plays_used": plays_used,
        "show_remaining": client_config["showRemaining"],
        "src": src,
        "video": media_type is MediaType.VIDEO,
        "youtube": youtube,
    }
    template = (
        Path(__file__).with_name("pl-media-player.mustache").read_text(encoding="utf-8")
    )
    return chevron.render(template, params).strip()
