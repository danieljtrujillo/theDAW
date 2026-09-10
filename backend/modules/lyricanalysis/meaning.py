"""Double meanings, found from the words rather than guessed at by a model.

The ``meaning`` family used to be empty unless the optional LLM pass was
switched on, so a lyric built on a pun came back with the pun unmentioned.
Most of what a reader calls a double meaning is not interpretive at all — it
is a fact about the language, and three of those facts are checkable:

* **homophone play** — two spellings in the lyric that sound identical
  ("their"/"there", "sole"/"soul"). The dictionary proves it; nothing is
  guessed. This is the strongest finding here.
* **heteronyms** — one spelling with two readings and two meanings
  ("record", "live", "tear"). Which one the singer sang is a choice, and the
  rhyme depends on it, so the writer should be told the fork is there.
* **words that carry a second sense** — "bars", "hook", "change", "cold".
  A curated list, because English has no machine-readable sense inventory in
  this repo and a sense count invented from spelling would be a lie. A word
  that recurs is the stronger claim (the same word twice, meaning two things,
  is antanaclasis); a single occurrence is a nudge, and is pitched below the
  pane's default confidence floor so it only appears when it is asked for.

Everything here is deterministic and reproducible. The LLM pass still adds
metaphor, irony and imagery on top; these are the ones that do not need it.
"""

from __future__ import annotations

from dataclasses import dataclass

from .phonetics import homophone_key, normalize_word, pronounce, pronunciations

# --- tuning ----------------------------------------------------------------

# Both spellings are in the lyric and they sound the same. Nothing about this
# is a guess.
HOMOPHONE_PLAY_CONF = 0.9
# One spelling, two dictionary readings, two meanings.
HETERONYM_CONF = 0.7
# A word with a well-known second sense, used more than once: the same word
# meaning two things is the oldest pun there is.
DOUBLE_SENSE_REPEAT_CONF = 0.65
# The same word once. Real, but a nudge rather than a finding — deliberately
# under the pane's default floor of 0.5.
DOUBLE_SENSE_CONF = 0.45
# The lyric has one half of a homophone pair and not the other. Worth knowing
# while writing; not worth asserting.
HOMOPHONE_ECHO_CONF = 0.4

# A word has to recur within this many lines for the second use to read as
# deliberate rather than as coincidence.
REPEAT_LINE_WINDOW = 12


# --- the tables ------------------------------------------------------------
#
# Curated, and deliberately short. Every entry earns its place by being a
# word a songwriter actually reaches for AND carrying a second sense strong
# enough that a reader would notice the play. A long list of technically
# polysemous words ("run", "set", "go") would mark half of every lyric and
# teach the writer to ignore the family.

# One spelling, two pronunciations, two meanings. The gloss pairs are ordered
# to match the dictionary's own reading order where it has both.
_HETERONYMS: dict[str, tuple[str, str]] = {
    "bass": ("the low end", "the fish"),
    "bow": (
        "bend at the waist / the front of a ship",
        "a knot, or the one for a violin",
    ),
    "close": ("near", "to shut"),
    "content": ("what is inside", "satisfied"),
    "desert": ("the sand", "to abandon"),
    "does": ("performs", "more than one doe"),
    "dove": ("the bird", "went in headfirst"),
    "excuse": ("the reason given", "to let off"),
    "invalid": ("someone unwell", "not valid"),
    "lead": ("the metal", "to go first"),
    "learned": ("came to know", "deeply schooled"),
    "live": ("to be alive", "happening now"),
    "minute": ("sixty seconds", "tiny"),
    "moped": ("sulked", "the little bike"),
    "number": ("a figure, or a song", "more numb"),
    "object": ("a thing", "to refuse"),
    "present": ("here, or a gift", "to hand over"),
    "produce": ("to make", "what is grown"),
    "read": ("do read", "already did"),
    "record": ("the disc", "to capture"),
    "refuse": ("to say no", "rubbish"),
    "resume": ("to carry on", "the history you hand in"),
    "row": ("a line", "a fight"),
    "sewer": ("the drain", "one who sews"),
    "sow": ("to plant", "the pig"),
    "subject": ("what it is about", "to put through"),
    "tear": ("what falls from an eye", "to rip"),
    "wind": ("the air moving", "to turn"),
    "wound": ("the injury", "turned, or coiled"),
}

# Words carrying a second sense strong enough that using them is a choice.
# Weighted toward the vocabulary of songs: the body, money, music, weather,
# distance, and the words that mean both a feeling and a thing.
_DOUBLE_SENSE: dict[str, tuple[str, str]] = {
    "bars": ("where you drink, or the ones you are behind", "the lines of a verse"),
    "bank": ("where the money is", "the side of a river"),
    "beat": ("the rhythm", "worn out, or struck"),
    "bill": ("what is owed", "a bird's beak, or the money"),
    "bitter": ("the taste", "the grudge"),
    "blue": ("the colour", "the mood"),
    "bond": ("what ties two people", "the debt, or the glue"),
    "break": ("to shatter", "the rest, or the chance"),
    "bridge": ("what crosses the water", "the part of the song"),
    "burn": ("the fire", "the insult, or the ache"),
    "capital": ("the city", "the money"),
    "cell": ("the room they lock", "the phone, or the body's own"),
    "change": ("to become other", "the coins"),
    "charge": ("what it costs", "to rush, or the current"),
    "cold": ("the weather", "the way a person can be"),
    "count": ("to number", "to matter, or to rely on"),
    "crown": ("what a king wears", "the top of the head"),
    "cut": ("the wound", "the track, or the share"),
    "dark": ("no light", "what a person hides"),
    "deal": ("the bargain", "to hand out"),
    "draw": ("to sketch", "to pull, or the tie"),
    "drill": ("the tool", "the practice, or the sound"),
    "drop": ("to let fall", "the moment the beat lands"),
    "fall": ("to drop", "the season, or to fail"),
    "fast": ("quick", "held tight, or going without"),
    "fine": ("all right", "the penalty, or delicate"),
    "fire": ("the flame", "to sack, or to shoot"),
    "flat": ("level", "the note, or the home"),
    "fly": ("to leave the ground", "sharp-looking, or the insect"),
    "free": ("costing nothing", "not held"),
    "grave": ("where the dead lie", "serious"),
    "green": ("the colour", "the money, or new to it"),
    "grind": ("to wear down", "the work you keep doing"),
    "hard": ("solid", "difficult, or unfeeling"),
    "heavy": ("weighs a lot", "hard to carry, in the other sense"),
    "high": ("far up", "what a drug does"),
    "hit": ("to strike", "the song everyone knows"),
    "hold": ("to grip", "the ship's belly, or the pause"),
    "hook": ("what catches", "the line you cannot shake"),
    "keys": ("what opens a door", "the piano's, or the key of the song"),
    "kill": ("to end a life", "to destroy it, on stage"),
    "light": ("not heavy", "what lets you see"),
    "line": ("the words", "the queue, the border, or the drug"),
    "long": ("the length", "to ache for"),
    "lost": ("cannot be found", "cannot find your way"),
    "low": ("not high", "the mood, or the sound"),
    "mine": ("belongs to me", "the hole in the ground, or the bomb"),
    "note": ("the sound", "what you wrote down, or the money"),
    "old": ("aged", "the way you say a friend's name"),
    "out": ("not in", "no longer hidden"),
    "over": ("above", "finished"),
    "pass": ("to go by", "to hand on, or to give up your turn"),
    "pitch": ("how high the note", "the sell, or the throw"),
    "play": ("to make music", "to fool with someone"),
    "plate": ("what you eat off", "the armour, or the metal"),
    "pound": ("the money", "to beat"),
    "press": ("to push", "the papers"),
    "rest": ("to stop", "the silence in the bar, or what is left"),
    "ring": ("the sound", "what you wear, or the circle"),
    "rock": ("the stone", "the music, or to sway"),
    "roll": ("to turn over", "the money, or the drums"),
    "root": ("what holds the tree", "where you come from, or the chord's own"),
    "rough": ("not smooth", "hard going"),
    "run": ("to move fast", "to manage, or the streak"),
    "safe": ("out of danger", "the box"),
    "scale": ("the notes going up", "to climb, or the weight"),
    "score": ("the music written", "the number, or getting what you came for"),
    "sharp": ("cuts", "the note, or the mind"),
    "sheet": ("the paper", "what is on the bed"),
    "shot": ("the bullet", "the try, or the drink"),
    "sick": ("unwell", "unbelievably good"),
    "sign": ("the writing on it", "the omen, or to put your name"),
    "sleep": ("the rest", "the long one"),
    "smoke": ("what the fire leaves", "to burn one, or to beat someone badly"),
    "sound": ("what you hear", "whole and well, or the water"),
    "space": ("the room", "the sky, or the distance between two people"),
    "spell": ("the letters", "the magic, or the stretch of time"),
    "spring": ("the season", "the water, the coil, or to leap"),
    "stage": ("where you play", "the part of the journey"),
    "state": ("the place", "the condition, or to say"),
    "steal": ("to take", "the bargain"),
    "still": ("even now", "not moving, or the quiet"),
    "straight": ("not bent", "honest, or sober"),
    "strike": ("to hit", "to stop working, or to find it"),
    "strings": ("what you play", "what is attached to the favour"),
    "sun": ("the star", "the day itself"),
    "sweet": ("the taste", "the kindness"),
    "swing": ("to move through the air", "the feel of the beat"),
    "tag": ("the label", "the name you spray"),
    "time": ("the clock", "the meter of the song, or the sentence"),
    "tip": ("the end of it", "the money, or the advice"),
    "track": ("the song", "the path, or to follow"),
    "trip": ("to stumble", "the journey, or what the drug does"),
    "tune": ("the melody", "to bring into pitch"),
    "turn": ("to rotate", "your go, or to change on someone"),
    "waste": ("to squander", "what is thrown away"),
    "watch": ("to look", "what is on your wrist, or the shift"),
    "wave": ("the water", "the hand, or the movement"),
    "weight": ("how heavy", "what you carry"),
    "well": ("all right", "the hole with the water in it"),
    "wire": ("the metal", "the message, or the bug"),
}

# Homophone groups worth knowing about when only one of them is written.
# Curated rather than taken from the dictionary's whole 130,000 words: a
# reverse index there pairs everything with something, most of it obscure,
# and the finding stops meaning anything.
_HOMOPHONE_SETS: tuple[tuple[str, ...], ...] = (
    ("aisle", "isle", "ill"),
    ("allowed", "aloud"),
    ("altar", "alter"),
    ("ate", "eight"),
    ("bare", "bear"),
    ("beat", "beet"),
    ("been", "bean"),
    ("berry", "bury"),
    ("blue", "blew"),
    ("board", "bored"),
    ("brake", "break"),
    ("bread", "bred"),
    ("buy", "by", "bye"),
    ("cell", "sell"),
    ("cent", "scent", "sent"),
    ("cheap", "cheep"),
    ("chord", "cord"),
    ("coarse", "course"),
    ("dear", "deer"),
    ("die", "dye"),
    ("dual", "duel"),
    ("eye", "aye"),
    ("fair", "fare"),
    ("feat", "feet"),
    ("flew", "flu", "flue"),
    ("flour", "flower"),
    ("for", "four", "fore"),
    ("great", "grate"),
    ("groan", "grown"),
    ("hair", "hare"),
    ("heal", "heel", "he'll"),
    ("hear", "here"),
    ("heard", "herd"),
    ("higher", "hire"),
    ("hole", "whole"),
    ("holy", "wholly"),
    ("hour", "our"),
    ("idle", "idol"),
    ("knight", "night"),
    ("knot", "not"),
    ("know", "no"),
    ("leak", "leek"),
    ("lessen", "lesson"),
    ("liar", "lyre"),
    ("lie", "lye"),
    ("loan", "lone"),
    ("made", "maid"),
    ("mail", "male"),
    ("main", "mane"),
    ("meat", "meet", "mete"),
    ("might", "mite"),
    ("mind", "mined"),
    ("miner", "minor"),
    ("missed", "mist"),
    ("morning", "mourning"),
    ("none", "nun"),
    ("one", "won"),
    ("pain", "pane"),
    ("pair", "pear", "pare"),
    ("past", "passed"),
    ("peace", "piece"),
    ("plain", "plane"),
    ("pray", "prey"),
    ("principal", "principle"),
    ("rain", "reign", "rein"),
    ("raise", "rays", "raze"),
    ("read", "reed"),
    ("real", "reel"),
    ("right", "write", "rite"),
    ("road", "rode", "rowed"),
    ("role", "roll"),
    ("root", "route"),
    ("rose", "rows"),
    ("sail", "sale"),
    ("scene", "seen"),
    ("sea", "see"),
    ("seam", "seem"),
    ("sight", "site", "cite"),
    ("sole", "soul"),
    ("some", "sum"),
    ("son", "sun"),
    ("stair", "stare"),
    ("stake", "steak"),
    ("steal", "steel"),
    ("suite", "sweet"),
    ("tail", "tale"),
    ("their", "there", "they're"),
    ("threw", "through"),
    ("thrown", "throne"),
    ("tide", "tied"),
    ("to", "too", "two"),
    ("toe", "tow"),
    ("vain", "vein", "vane"),
    ("waist", "waste"),
    ("wait", "weight"),
    ("war", "wore"),
    ("way", "weigh", "whey"),
    ("weak", "week"),
    ("wear", "where", "ware"),
    ("weather", "whether"),
    ("which", "witch"),
    ("wood", "would"),
    ("your", "you're"),
)

_HOMOPHONE_PARTNERS: dict[str, tuple[str, ...]] = {
    word: tuple(other for other in group if other != word)
    for group in _HOMOPHONE_SETS
    for word in group
}


@dataclass(frozen=True)
class Occurrence:
    """One written word of the lyric, as the meaning pass needs to see it."""

    line: int
    word: int
    raw: str
    norm: str


def same_sound(a: str, b: str) -> bool:
    """Do two spellings share a pronunciation?

    Any reading against any reading: "read"/"reed" are homophones under one of
    "read"'s two readings and not under the other, and that is precisely the
    play worth reporting.
    """
    keys_a = {homophone_key(p) for p in pronunciations(a)}
    if not keys_a:
        return False
    return any(homophone_key(p) in keys_a for p in pronunciations(b))


def heteronym_glosses(word: str) -> tuple[str, str] | None:
    """The two senses of a heteronym, or ``None`` when it is not one."""
    return _HETERONYMS.get(word)


def double_sense_glosses(word: str) -> tuple[str, str] | None:
    """The two senses of a word that carries one, or ``None``."""
    return _DOUBLE_SENSE.get(word)


def homophone_partners(word: str) -> tuple[str, ...]:
    """Common spellings that sound the same as ``word``."""
    return _HOMOPHONE_PARTNERS.get(word, ())


def heteronym_readings(word: str) -> tuple[str, ...]:
    """The dictionary's readings of a heteronym, as ARPABET, best first.

    Empty when the dictionary has only one — a heteronym is still a heteronym
    without cmudict installed, it just cannot show its two readings.
    """
    prons = pronunciations(word)
    if len(prons) < 2:
        return ()
    return tuple(" ".join(p.phones) for p in prons)


def is_pronounceable(word: str) -> bool:
    """A word the meaning pass can say anything about at all."""
    return bool(word) and bool(pronounce(word).phones)


def normalise(raw: str) -> str:
    """The lyric's own normalisation, re-exported so callers need one import."""
    return normalize_word(raw)


__all__ = [
    "DOUBLE_SENSE_CONF",
    "DOUBLE_SENSE_REPEAT_CONF",
    "HETERONYM_CONF",
    "HOMOPHONE_ECHO_CONF",
    "HOMOPHONE_PLAY_CONF",
    "REPEAT_LINE_WINDOW",
    "Occurrence",
    "double_sense_glosses",
    "heteronym_glosses",
    "heteronym_readings",
    "homophone_partners",
    "is_pronounceable",
    "normalise",
    "same_sound",
]
