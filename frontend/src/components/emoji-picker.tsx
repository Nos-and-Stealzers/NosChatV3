"use client";

import { useMemo, useState } from "react";
import { Search } from "lucide-react";

// A real categorized + searchable emoji picker — no external library
// dependency (native Unicode emoji render fine in every modern browser),
// just a much larger curated set than the old QUICK_EMOJIS/REACTION_EMOJIS
// arrays, organized into Discord-style category tabs with a search box
// that matches on the emoji's keyword tags.
type EmojiEntry = { char: string; keywords: string };

const CATEGORIES: { id: string; label: string; emojis: EmojiEntry[] }[] = [
  {
    id: "smileys",
    label: "Smileys",
    emojis: [
      { char: "😀", keywords: "grinning happy smile" },
      { char: "😃", keywords: "smiley happy" },
      { char: "😄", keywords: "smile happy laugh" },
      { char: "😁", keywords: "grin happy" },
      { char: "😆", keywords: "laughing lol haha" },
      { char: "😅", keywords: "sweat smile relief" },
      { char: "🤣", keywords: "rofl rolling floor laughing" },
      { char: "😂", keywords: "joy tears laughing lol" },
      { char: "🙂", keywords: "slight smile" },
      { char: "🙃", keywords: "upside down" },
      { char: "😉", keywords: "wink" },
      { char: "😊", keywords: "blush happy" },
      { char: "😇", keywords: "innocent angel halo" },
      { char: "🥰", keywords: "love hearts smiling" },
      { char: "😍", keywords: "heart eyes love" },
      { char: "🤩", keywords: "star struck excited" },
      { char: "😘", keywords: "kiss blow" },
      { char: "😗", keywords: "kissing" },
      { char: "😋", keywords: "yum tongue tasty" },
      { char: "😛", keywords: "tongue out playful" },
      { char: "😜", keywords: "wink tongue crazy" },
      { char: "🤪", keywords: "zany crazy silly" },
      { char: "😝", keywords: "tongue squint" },
      { char: "🤑", keywords: "money mouth rich" },
      { char: "🤗", keywords: "hug hands" },
      { char: "🤭", keywords: "hand over mouth oops" },
      { char: "🤫", keywords: "shush quiet secret" },
      { char: "🤔", keywords: "thinking hmm" },
      { char: "🤐", keywords: "zipper mouth silent" },
      { char: "🤨", keywords: "raised eyebrow suspicious" },
      { char: "😐", keywords: "neutral" },
      { char: "😑", keywords: "expressionless blank" },
      { char: "😶", keywords: "no mouth silent" },
      { char: "😏", keywords: "smirk" },
      { char: "😒", keywords: "unamused annoyed" },
      { char: "🙄", keywords: "eye roll annoyed" },
      { char: "😬", keywords: "grimace awkward" },
      { char: "🤥", keywords: "lying pinocchio" },
      { char: "😌", keywords: "relieved content" },
      { char: "😔", keywords: "pensive sad" },
      { char: "😪", keywords: "sleepy tired" },
      { char: "🤤", keywords: "drooling" },
      { char: "😴", keywords: "sleeping zzz" },
      { char: "😷", keywords: "mask sick" },
      { char: "🤒", keywords: "sick thermometer" },
      { char: "🤕", keywords: "hurt bandage" },
      { char: "🤢", keywords: "nauseated sick" },
      { char: "🤮", keywords: "vomiting sick" },
      { char: "🥵", keywords: "hot heat" },
      { char: "🥶", keywords: "cold freezing" },
      { char: "😵", keywords: "dizzy knocked out" },
      { char: "🤯", keywords: "mind blown exploding head" },
      { char: "🥳", keywords: "party celebration" },
      { char: "😎", keywords: "cool sunglasses" },
      { char: "🤓", keywords: "nerd glasses" },
      { char: "🧐", keywords: "monocle curious" },
      { char: "😕", keywords: "confused" },
      { char: "😟", keywords: "worried" },
      { char: "🙁", keywords: "frown sad" },
      { char: "😮", keywords: "open mouth surprised" },
      { char: "😯", keywords: "hushed surprised" },
      { char: "😲", keywords: "astonished shocked" },
      { char: "😳", keywords: "flushed embarrassed" },
      { char: "🥺", keywords: "pleading puppy eyes" },
      { char: "😦", keywords: "frowning open mouth" },
      { char: "😧", keywords: "anguished" },
      { char: "😨", keywords: "fearful scared" },
      { char: "😰", keywords: "anxious sweat" },
      { char: "😥", keywords: "sad relieved" },
      { char: "😢", keywords: "cry sad tear" },
      { char: "😭", keywords: "sob crying loud" },
      { char: "😱", keywords: "scream fear scared" },
      { char: "😖", keywords: "confounded" },
      { char: "😣", keywords: "persevere struggle" },
      { char: "😞", keywords: "disappointed" },
      { char: "😓", keywords: "downcast sweat" },
      { char: "😩", keywords: "weary tired" },
      { char: "😫", keywords: "tired exhausted" },
      { char: "🥱", keywords: "yawn tired" },
      { char: "😤", keywords: "triumph huff steam" },
      { char: "😡", keywords: "angry mad rage" },
      { char: "😠", keywords: "angry mad" },
      { char: "🤬", keywords: "cursing swearing angry" },
      { char: "😈", keywords: "smiling devil evil" },
      { char: "👿", keywords: "angry devil" },
      { char: "💀", keywords: "skull dead" },
      { char: "☠️", keywords: "skull crossbones danger" },
      { char: "💩", keywords: "poop shit" },
      { char: "🤡", keywords: "clown" },
      { char: "👹", keywords: "ogre monster" },
      { char: "👺", keywords: "goblin monster" },
      { char: "👻", keywords: "ghost spooky" },
      { char: "👽", keywords: "alien ufo" },
      { char: "🤖", keywords: "robot" },
    ],
  },
  {
    id: "gestures",
    label: "Gestures",
    emojis: [
      { char: "👍", keywords: "thumbs up good yes" },
      { char: "👎", keywords: "thumbs down bad no" },
      { char: "👌", keywords: "ok okay" },
      { char: "🤌", keywords: "pinched fingers italian" },
      { char: "✌️", keywords: "peace victory" },
      { char: "🤞", keywords: "fingers crossed hope" },
      { char: "🤟", keywords: "love you gesture" },
      { char: "🤘", keywords: "rock horns metal" },
      { char: "🤙", keywords: "call me shaka" },
      { char: "👈", keywords: "point left" },
      { char: "👉", keywords: "point right" },
      { char: "👆", keywords: "point up" },
      { char: "👇", keywords: "point down" },
      { char: "☝️", keywords: "point up one" },
      { char: "👋", keywords: "wave hello bye" },
      { char: "🤚", keywords: "raised back hand" },
      { char: "🖐️", keywords: "hand fingers splayed" },
      { char: "✋", keywords: "raised hand stop" },
      { char: "🖖", keywords: "vulcan spock" },
      { char: "👏", keywords: "clap applause" },
      { char: "🙌", keywords: "raised hands praise celebrate" },
      { char: "🤝", keywords: "handshake deal" },
      { char: "🙏", keywords: "pray please thanks" },
      { char: "✍️", keywords: "writing hand" },
      { char: "💪", keywords: "muscle strong flex" },
      { char: "🦾", keywords: "mechanical arm strong" },
      { char: "🫡", keywords: "salute respect" },
      { char: "🫶", keywords: "heart hands love" },
      { char: "👀", keywords: "eyes looking sus" },
      { char: "🧠", keywords: "brain smart" },
    ],
  },
  {
    id: "hearts",
    label: "Hearts",
    emojis: [
      { char: "❤️", keywords: "red heart love" },
      { char: "🧡", keywords: "orange heart" },
      { char: "💛", keywords: "yellow heart" },
      { char: "💚", keywords: "green heart" },
      { char: "💙", keywords: "blue heart" },
      { char: "💜", keywords: "purple heart" },
      { char: "🖤", keywords: "black heart" },
      { char: "🤍", keywords: "white heart" },
      { char: "🤎", keywords: "brown heart" },
      { char: "💔", keywords: "broken heart sad" },
      { char: "❣️", keywords: "heart exclamation" },
      { char: "💕", keywords: "two hearts" },
      { char: "💞", keywords: "revolving hearts" },
      { char: "💓", keywords: "beating heart" },
      { char: "💗", keywords: "growing heart" },
      { char: "💖", keywords: "sparkling heart" },
      { char: "💘", keywords: "heart arrow cupid" },
      { char: "💝", keywords: "heart gift ribbon" },
      { char: "💯", keywords: "hundred perfect score" },
      { char: "💢", keywords: "anger symbol" },
      { char: "💥", keywords: "boom explosion" },
      { char: "💫", keywords: "dizzy stars" },
      { char: "💦", keywords: "sweat splash droplets" },
      { char: "💨", keywords: "dash wind fast" },
      { char: "🔥", keywords: "fire lit hot" },
      { char: "✨", keywords: "sparkles shiny" },
      { char: "⭐", keywords: "star" },
      { char: "🌟", keywords: "glowing star" },
      { char: "⚡", keywords: "lightning bolt zap" },
    ],
  },
  {
    id: "animals",
    label: "Animals",
    emojis: [
      { char: "🐶", keywords: "dog puppy" },
      { char: "🐱", keywords: "cat kitten" },
      { char: "🐭", keywords: "mouse" },
      { char: "🐹", keywords: "hamster" },
      { char: "🐰", keywords: "rabbit bunny" },
      { char: "🦊", keywords: "fox" },
      { char: "🐻", keywords: "bear" },
      { char: "🐼", keywords: "panda" },
      { char: "🐨", keywords: "koala" },
      { char: "🐯", keywords: "tiger" },
      { char: "🦁", keywords: "lion" },
      { char: "🐮", keywords: "cow" },
      { char: "🐷", keywords: "pig" },
      { char: "🐸", keywords: "frog" },
      { char: "🐵", keywords: "monkey" },
      { char: "🙈", keywords: "see no evil monkey" },
      { char: "🙉", keywords: "hear no evil monkey" },
      { char: "🙊", keywords: "speak no evil monkey" },
      { char: "🐔", keywords: "chicken" },
      { char: "🐧", keywords: "penguin" },
      { char: "🐦", keywords: "bird" },
      { char: "🐤", keywords: "chick" },
      { char: "🦆", keywords: "duck" },
      { char: "🦅", keywords: "eagle" },
      { char: "🦉", keywords: "owl" },
      { char: "🦇", keywords: "bat" },
      { char: "🐺", keywords: "wolf" },
      { char: "🐗", keywords: "boar" },
      { char: "🐴", keywords: "horse" },
      { char: "🦄", keywords: "unicorn" },
      { char: "🐝", keywords: "bee" },
      { char: "🐛", keywords: "bug caterpillar" },
      { char: "🦋", keywords: "butterfly" },
      { char: "🐌", keywords: "snail" },
      { char: "🐞", keywords: "ladybug" },
      { char: "🐢", keywords: "turtle" },
      { char: "🐍", keywords: "snake" },
      { char: "🐙", keywords: "octopus" },
      { char: "🦑", keywords: "squid" },
      { char: "🦐", keywords: "shrimp" },
      { char: "🐠", keywords: "fish tropical" },
      { char: "🐟", keywords: "fish" },
      { char: "🐬", keywords: "dolphin" },
      { char: "🐳", keywords: "whale" },
      { char: "🦈", keywords: "shark" },
    ],
  },
  {
    id: "food",
    label: "Food",
    emojis: [
      { char: "🍏", keywords: "green apple" },
      { char: "🍎", keywords: "red apple" },
      { char: "🍊", keywords: "orange tangerine" },
      { char: "🍋", keywords: "lemon" },
      { char: "🍌", keywords: "banana" },
      { char: "🍉", keywords: "watermelon" },
      { char: "🍇", keywords: "grapes" },
      { char: "🍓", keywords: "strawberry" },
      { char: "🍒", keywords: "cherries" },
      { char: "🍑", keywords: "peach" },
      { char: "🥭", keywords: "mango" },
      { char: "🍍", keywords: "pineapple" },
      { char: "🥥", keywords: "coconut" },
      { char: "🥝", keywords: "kiwi" },
      { char: "🍅", keywords: "tomato" },
      { char: "🍆", keywords: "eggplant" },
      { char: "🥑", keywords: "avocado" },
      { char: "🌽", keywords: "corn" },
      { char: "🥕", keywords: "carrot" },
      { char: "🥔", keywords: "potato" },
      { char: "🍞", keywords: "bread" },
      { char: "🥐", keywords: "croissant" },
      { char: "🥯", keywords: "bagel" },
      { char: "🧀", keywords: "cheese" },
      { char: "🍗", keywords: "chicken leg meat" },
      { char: "🍕", keywords: "pizza" },
      { char: "🌭", keywords: "hot dog" },
      { char: "🍔", keywords: "hamburger burger" },
      { char: "🍟", keywords: "fries" },
      { char: "🌮", keywords: "taco" },
      { char: "🌯", keywords: "burrito" },
      { char: "🥪", keywords: "sandwich" },
      { char: "🍜", keywords: "ramen noodles" },
      { char: "🍝", keywords: "pasta spaghetti" },
      { char: "🍣", keywords: "sushi" },
      { char: "🍱", keywords: "bento box" },
      { char: "🍦", keywords: "ice cream soft serve" },
      { char: "🍩", keywords: "donut doughnut" },
      { char: "🍪", keywords: "cookie" },
      { char: "🎂", keywords: "cake birthday" },
      { char: "🍰", keywords: "cake slice" },
      { char: "🍫", keywords: "chocolate" },
      { char: "🍿", keywords: "popcorn" },
      { char: "☕", keywords: "coffee" },
      { char: "🍺", keywords: "beer" },
      { char: "🍻", keywords: "cheers beer" },
      { char: "🍷", keywords: "wine" },
      { char: "🥂", keywords: "champagne toast" },
      { char: "🍾", keywords: "champagne bottle" },
    ],
  },
  {
    id: "activities",
    label: "Activities",
    emojis: [
      { char: "⚽", keywords: "soccer football" },
      { char: "🏀", keywords: "basketball" },
      { char: "🏈", keywords: "american football" },
      { char: "⚾", keywords: "baseball" },
      { char: "🎾", keywords: "tennis" },
      { char: "🏐", keywords: "volleyball" },
      { char: "🏉", keywords: "rugby" },
      { char: "🎱", keywords: "8 ball pool billiards" },
      { char: "🏓", keywords: "ping pong table tennis" },
      { char: "🏸", keywords: "badminton" },
      { char: "🥊", keywords: "boxing glove" },
      { char: "🥋", keywords: "martial arts" },
      { char: "⛳", keywords: "golf" },
      { char: "🎣", keywords: "fishing" },
      { char: "🎽", keywords: "running shirt" },
      { char: "🎿", keywords: "skiing" },
      { char: "🎯", keywords: "dart target bullseye" },
      { char: "🎮", keywords: "video game controller gaming" },
      { char: "🕹️", keywords: "joystick gaming" },
      { char: "🎲", keywords: "dice game" },
      { char: "🎳", keywords: "bowling" },
      { char: "🎸", keywords: "guitar music" },
      { char: "🎹", keywords: "piano keyboard music" },
      { char: "🎺", keywords: "trumpet music" },
      { char: "🎷", keywords: "saxophone music" },
      { char: "🥁", keywords: "drum music" },
      { char: "🎨", keywords: "art paint palette" },
      { char: "🎭", keywords: "theater drama masks" },
      { char: "🏆", keywords: "trophy win winner" },
      { char: "🥇", keywords: "gold medal first" },
      { char: "🥈", keywords: "silver medal second" },
      { char: "🥉", keywords: "bronze medal third" },
    ],
  },
  {
    id: "objects",
    label: "Objects",
    emojis: [
      { char: "💻", keywords: "laptop computer" },
      { char: "🖥️", keywords: "desktop computer" },
      { char: "⌨️", keywords: "keyboard" },
      { char: "🖱️", keywords: "mouse computer" },
      { char: "🖨️", keywords: "printer" },
      { char: "📱", keywords: "phone mobile" },
      { char: "☎️", keywords: "telephone" },
      { char: "📷", keywords: "camera" },
      { char: "📹", keywords: "video camera" },
      { char: "🎥", keywords: "movie camera" },
      { char: "📺", keywords: "tv television" },
      { char: "🎧", keywords: "headphones" },
      { char: "🎤", keywords: "microphone mic" },
      { char: "🔋", keywords: "battery" },
      { char: "🔌", keywords: "plug charger" },
      { char: "💡", keywords: "bulb idea light" },
      { char: "🔦", keywords: "flashlight" },
      { char: "📚", keywords: "books" },
      { char: "📖", keywords: "book open" },
      { char: "✏️", keywords: "pencil" },
      { char: "🖊️", keywords: "pen" },
      { char: "📝", keywords: "memo notes" },
      { char: "📌", keywords: "pin" },
      { char: "📎", keywords: "paperclip" },
      { char: "✂️", keywords: "scissors cut" },
      { char: "🔒", keywords: "locked" },
      { char: "🔓", keywords: "unlocked" },
      { char: "🔑", keywords: "key" },
      { char: "🔨", keywords: "hammer tool" },
      { char: "🔧", keywords: "wrench tool" },
      { char: "⚙️", keywords: "gear settings" },
      { char: "🧲", keywords: "magnet" },
      { char: "💰", keywords: "money bag" },
      { char: "💵", keywords: "dollar cash" },
      { char: "💳", keywords: "credit card" },
      { char: "💎", keywords: "gem diamond" },
      { char: "⚖️", keywords: "scales balance justice" },
      { char: "🔔", keywords: "bell notification" },
      { char: "🔕", keywords: "bell muted" },
      { char: "📢", keywords: "loudspeaker announce" },
      { char: "📣", keywords: "megaphone" },
    ],
  },
  {
    id: "symbols",
    label: "Symbols",
    emojis: [
      { char: "✅", keywords: "check mark yes done" },
      { char: "❌", keywords: "cross mark no" },
      { char: "❎", keywords: "cross mark button" },
      { char: "➕", keywords: "plus add" },
      { char: "➖", keywords: "minus subtract" },
      { char: "❓", keywords: "question mark" },
      { char: "❗", keywords: "exclamation mark" },
      { char: "‼️", keywords: "double exclamation" },
      { char: "⁉️", keywords: "interrobang" },
      { char: "💤", keywords: "sleeping zzz" },
      { char: "🚫", keywords: "no entry prohibited" },
      { char: "⛔", keywords: "no entry stop" },
      { char: "🔞", keywords: "18 plus adult" },
      { char: "🆗", keywords: "ok button" },
      { char: "🆕", keywords: "new button" },
      { char: "🔴", keywords: "red circle" },
      { char: "🟠", keywords: "orange circle" },
      { char: "🟡", keywords: "yellow circle" },
      { char: "🟢", keywords: "green circle" },
      { char: "🔵", keywords: "blue circle" },
      { char: "🟣", keywords: "purple circle" },
      { char: "⚫", keywords: "black circle" },
      { char: "⚪", keywords: "white circle" },
      { char: "🟥", keywords: "red square" },
      { char: "🟩", keywords: "green square" },
      { char: "🟦", keywords: "blue square" },
      { char: "⬆️", keywords: "up arrow" },
      { char: "⬇️", keywords: "down arrow" },
      { char: "⬅️", keywords: "left arrow" },
      { char: "➡️", keywords: "right arrow" },
      { char: "🔁", keywords: "repeat loop" },
      { char: "🔀", keywords: "shuffle" },
    ],
  },
];

const ALL_EMOJIS = CATEGORIES.flatMap((c) => c.emojis);
const RECENTS_STORAGE_KEY = "noschat.recentEmojis";
const MAX_RECENTS = 16;

function loadRecents(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(RECENTS_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

export function recordRecentEmoji(char: string) {
  if (typeof window === "undefined") return;
  const recents = loadRecents().filter((e) => e !== char);
  recents.unshift(char);
  window.localStorage.setItem(RECENTS_STORAGE_KEY, JSON.stringify(recents.slice(0, MAX_RECENTS)));
}

// Real Discord-style emoji picker: category tabs + search, backed by a
// large curated native-Unicode set (no external library dependency) plus
// a "Recent" tab backed by localStorage. Used for both the composer's
// insert-emoji button and (via the same component) message reactions.
export function EmojiPicker({ onPick }: { onPick: (emoji: string) => void }) {
  const [query, setQuery] = useState("");
  const [activeCategory, setActiveCategory] = useState(CATEGORIES[0].id);
  const recents = useMemo(() => loadRecents(), []);

  const results = useMemo(() => {
    if (query.trim()) {
      const q = query.trim().toLowerCase();
      return ALL_EMOJIS.filter((e) => e.keywords.includes(q));
    }
    if (activeCategory === "recent") {
      return recents.map((char) => ({ char, keywords: "" }));
    }
    return CATEGORIES.find((c) => c.id === activeCategory)?.emojis ?? [];
  }, [query, activeCategory, recents]);

  function pick(char: string) {
    recordRecentEmoji(char);
    onPick(char);
  }

  return (
    <div className="flex h-80 w-72 flex-col overflow-hidden rounded-xl border border-white/[0.06] bg-gradient-to-b from-[#1E232C] to-[#161A20] shadow-[0_0_0_1px_rgba(240,168,104,0.06),0_20px_50px_-15px_rgba(0,0,0,0.7)]">
      <div className="flex-none border-b border-white/[0.06] p-2">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-[#8B93A1]" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search emoji"
            className="h-8 w-full rounded-lg border border-[#2A2F3A] bg-[#0F1217]/80 pr-2 pl-8 text-xs text-[#E8EAED] placeholder:text-[#8B93A1]/60 focus:border-[#F0A868]/50 focus:outline-none"
          />
        </div>
      </div>
      {!query.trim() && (
        <div className="noschat-scroll flex flex-none gap-1 overflow-x-auto border-b border-white/[0.06] px-2 py-1.5">
          {recents.length > 0 && (
            <button
              type="button"
              onClick={() => setActiveCategory("recent")}
              data-active={activeCategory === "recent"}
              className="flex-none rounded-md px-2 py-1 text-[10px] font-medium text-[#8B93A1] transition-colors hover:bg-[#1B1F27] hover:text-[#E8EAED] data-[active=true]:bg-[#1E232C] data-[active=true]:text-[#F0A868]"
            >
              Recent
            </button>
          )}
          {CATEGORIES.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => setActiveCategory(c.id)}
              data-active={activeCategory === c.id}
              className="flex-none rounded-md px-2 py-1 text-[10px] font-medium text-[#8B93A1] transition-colors hover:bg-[#1B1F27] hover:text-[#E8EAED] data-[active=true]:bg-[#1E232C] data-[active=true]:text-[#F0A868]"
            >
              {c.label}
            </button>
          ))}
        </div>
      )}
      <div className="noschat-scroll flex-1 overflow-y-auto p-2">
        {results.length === 0 ? (
          <p className="p-2 text-center text-xs text-[#8B93A1]">No emoji found</p>
        ) : (
          <div className="grid grid-cols-8 gap-0.5">
            {results.map((e, i) => (
              <button
                key={`${e.char}-${i}`}
                type="button"
                onClick={() => pick(e.char)}
                title={e.keywords}
                className="flex size-7 items-center justify-center rounded-md text-base transition-colors hover:bg-[#1B1F27]"
              >
                {e.char}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
