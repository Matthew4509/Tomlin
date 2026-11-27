// English text to the sound symbols Kokoro reads (the IPA set its tokenizer knows, with misaki's one-letter diphthongs
// A, I, O, W, Y), in plain code: no dictionary file and no npm package. Numbers and a few short forms are said in words
// first; each word is then looked up in a small list of common and irregular words (CMU-style sounds with stress), and
// any other word goes through letter-to-sound rules (the 1976 NRL rules, as in the public-domain english.c), with stress
// guessed from the word's ending. It reads ordinary English well enough for a voice-over; a rare name may come out
// wrong, and spelling it as it sounds fixes that. Plain parts: test/voice.test.ts.

// ---- Numbers and short forms, said in words ----

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const BIG: [number, string][] = [[1e12, 'trillion'], [1e9, 'billion'], [1e6, 'million'], [1e3, 'thousand']];

/** A whole number in words ("one thousand two hundred and five"); numbers past the trillions are read digit by digit. */
export function numberWords(n: number): string {
  if (!Number.isFinite(n) || n < 0 || n >= 1e15 || !Number.isInteger(n)) return String(n).split('').map(d => ONES[Number(d)] ?? '').filter(Boolean).join(' ');
  if (n < 20) return ONES[n];
  if (n < 100) return `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ''}`;
  if (n < 1000) return `${ONES[Math.floor(n / 100)]} hundred${n % 100 ? ` and ${numberWords(n % 100)}` : ''}`;
  for (const [size, word] of BIG) {
    if (n >= size) {
      const rest = n % size;
      return `${numberWords(Math.floor(n / size))} ${word}${rest ? (rest < 100 ? ' and ' : ' ') + numberWords(rest) : ''}`;
    }
  }
  return String(n);
}

/**
 * A whole number written in digits, in words: read from its digits, not made a JavaScript number first, so a number of
 * 16 figures or more (an order or reference number) keeps every digit and is read digit by digit.
 */
export function digitsWords(digits: string): string {
  const d = digits.replace(/,/g, '');
  return d.length < 16 ? numberWords(Number(d)) : d.split('').map(x => ONES[Number(x)]).join(' ');
}

/** A year as it is said: 1999 "nineteen ninety nine", 2005 "two thousand and five", 2026 "twenty twenty six". */
export function yearWords(n: number): string {
  if (n >= 2000 && n < 2010) return numberWords(n);
  const hi = Math.floor(n / 100);
  const lo = n % 100;
  return `${numberWords(hi)} ${lo === 0 ? 'hundred' : lo < 10 ? `oh ${ONES[lo]}` : numberWords(lo)}`;
}

const ORDINAL: Record<string, string> = { one: 'first', two: 'second', three: 'third', five: 'fifth', eight: 'eighth', nine: 'ninth', twelve: 'twelfth' };
/** "twenty one" to "twenty first". */
export function ordinalWords(words: string): string {
  const parts = words.split(' ');
  const last = parts.pop()!;
  const said = ORDINAL[last] ?? (last.endsWith('y') ? `${last.slice(0, -1)}ieth` : `${last}th`);
  return [...parts, said].join(' ');
}

const SHORT: [RegExp, string][] = [
  [/\bMrs\./g, 'missus'], [/\bMr\./g, 'mister'], [/\bMs\./g, 'miz'], [/\bDr\./g, 'doctor'], [/\bSt\.(?=\s+[A-Z])/g, 'saint'],
  [/\bvs\.?(?=\s)/gi, 'versus'], [/\betc\./gi, 'et cetera'], [/\be\.g\./gi, 'for example'], [/\bi\.e\./gi, 'that is'], [/\bNo\.(?=\s*\d)/g, 'number'],
];

/** Digits, money, per cent, times and a few short forms put in words, so the sentences can be split and read. */
export function sayInWords(text: string): string {
  let t = text.replace(/[‘’ʼ]/g, '\'').replace(/[“”]/g, '"').replace(/\.{3,}/g, '…').replace(/\s+(?:-{1,2}|–)\s+|--/g, ' — ');
  for (const [re, said] of SHORT) t = t.replace(re, said);
  t = t.replace(/&/g, ' and ').replace(/\+/g, ' plus ').replace(/@/g, ' at ');
  // 3:30 and 10:05.
  t = t.replace(/\b(\d{1,2}):(\d{2})\b/g, (_, h: string, m: string) => `${numberWords(Number(h))} ${m === '00' ? 'o\'clock' : Number(m) < 10 ? `oh ${ONES[Number(m)]}` : numberWords(Number(m))}`);
  // Money: $5, $3.50, £20, €1,000.
  t = t.replace(/([$£€])(\d[\d,]*)(?:\.(\d{2}))?\b/g, (_, sign: string, whole: string, cents: string | undefined) => {
    const n = Number(whole.replace(/,/g, ''));
    const unit = sign === '$' ? 'dollar' : sign === '£' ? 'pound' : 'euro';
    const small = sign === '£' ? 'pence' : 'cents';
    return `${digitsWords(whole)} ${unit}${n === 1 ? '' : 's'}${cents && Number(cents) ? ` and ${numberWords(Number(cents))} ${small}` : ''}`;
  });
  // 1st, 22nd, 3rd, 4th.
  t = t.replace(/\b(\d+)(?:st|nd|rd|th)\b/gi, (_, n: string) => ordinalWords(digitsWords(n)));
  // Years: a four-figure number from 1100 to 2099 on its own.
  t = t.replace(/(?<![\d,.])\b(1[1-9]\d\d|20\d\d)\b(?!,\d|\.\d)/g, (_, y: string) => yearWords(Number(y)));
  // Other numbers, with thousands commas, decimals and per cent.
  t = t.replace(/(-)?\b(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?(\s*%)?/g, (_, minus: string | undefined, whole: string, frac: string | undefined, pct: string | undefined) => {
    const said = `${minus ? 'minus ' : ''}${digitsWords(whole)}${frac ? ` point ${frac.split('').map(d => ONES[Number(d)]).join(' ')}` : ''}${pct ? ' percent' : ''}`;
    return ` ${said} `;
  });
  return t.replace(/[ \t]+/g, ' ').replace(/ ([,.;:!?…])/g, '$1').trim();
}

// ---- Words in the list: CMU-style sounds, 1 a stressed vowel, 2 a lighter stress, 0 none ----

const LIST = `a AH0|the DH AH0|an AH0 N|and AE0 N D|of AH0 V|to T UW0|in IH0 N|is IH0 Z|it IH0 T|you Y UW0|that DH AE1 T|he HH IY0
was W AH0 Z|for F AO0 R|on AA0 N|are AA0 R|as AE0 Z|with W IH0 DH|his HH IH0 Z|they DH EY0|i AY1|at AE0 T|be B IY0|this DH IH0 S
have HH AE0 V|from F R AH0 M|or AO0 R|one W AH1 N|had HH AE0 D|by B AY0|word W ER1 D|words W ER1 D Z|but B AH0 T|not N AA1 T
what W AH1 T|all AO1 L|were W ER0|we W IY0|when W EH0 N|your Y AO0 R|can K AE0 N|said S EH1 D|there DH EH0 R|use Y UW1 Z
each IY1 CH|which W IH0 CH|she SH IY0|do D UW0|how HH AW1|their DH EH0 R|if IH0 F|will W IH0 L|up AH1 P|other AH1 DH ER0
about AH0 B AW1 T|out AW1 T|many M EH1 N IY0|then DH EH0 N|them DH EH0 M|these DH IY0 Z|so S OW0|some S AH0 M|her HH ER0
would W UH0 D|make M EY1 K|like L AY1 K|him HH IH0 M|into IH1 N T UW0|time T AY1 M|has HH AE0 Z|look L UH1 K|two T UW1
more M AO1 R|write R AY1 T|go G OW1|goes G OW1 Z|see S IY1|number N AH1 M B ER0|no N OW1|way W EY1|could K UH0 D
people P IY1 P AH0 L|my M AY0|than DH AE0 N|first F ER1 S T|water W AO1 T ER0|been B IH0 N|call K AO1 L|who HH UW0
oil OY1 L|its IH0 T S|now N AW1|find F AY1 N D|long L AO1 NG|down D AW1 N|day D EY1|did D IH0 D|get G EH1 T|come K AH1 M
made M EY1 D|may M EY0|part P AA1 R T|over OW1 V ER0|new N UW1|sound S AW1 N D|take T EY1 K|only OW1 N L IY0
little L IH1 T AH0 L|work W ER1 K|know N OW1|place P L EY1 S|year Y IH1 R|years Y IH1 R Z|live L IH1 V|me M IY0|back B AE1 K
give G IH1 V|most M OW1 S T|very V EH1 R IY0|after AE1 F T ER0|thing TH IH1 NG|things TH IH1 NG Z|our AW1 R|just JH AH0 S T
name N EY1 M|good G UH1 D|sentence S EH1 N T AH0 N S|man M AE1 N|think TH IH1 NG K|say S EY1|says S EH1 Z|great G R EY1 T
where W EH1 R|help HH EH1 L P|through TH R UW1|much M AH1 CH|before B IH0 F AO1 R|line L AY1 N|right R AY1 T|too T UW1
mean M IY1 N|old OW1 L D|any EH1 N IY0|same S EY1 M|tell T EH1 L|boy B OY1|follow F AA1 L OW0|came K EY1 M|want W AA1 N T
show SH OW1|also AO1 L S OW0|around ER0 AW1 N D|form F AO1 R M|three TH R IY1|small S M AO1 L|set S EH1 T|put P UH1 T
end EH1 N D|does D AH1 Z|another AH0 N AH1 DH ER0|well W EH1 L|large L AA1 R JH|must M AH1 S T|big B IH1 G|even IY1 V IH0 N
such S AH1 CH|because B IH0 K AH1 Z|turn T ER1 N|here HH IY1 R|why W AY1|ask AE1 S K|went W EH1 N T|men M EH1 N|read R IY1 D
need N IY1 D|land L AE1 N D|different D IH1 F ER0 AH0 N T|home HH OW1 M|us AH0 S|move M UW1 V|try T R AY1|kind K AY1 N D
hand HH AE1 N D|picture P IH1 K CH ER0|again AH0 G EH1 N|change CH EY1 N JH|off AO1 F|play P L EY1|air EH1 R|away AH0 W EY1
animal AE1 N AH0 M AH0 L|house HH AW1 S|point P OY1 N T|page P EY1 JH|letter L EH1 T ER0|mother M AH1 DH ER0|answer AE1 N S ER0
found F AW1 N D|study S T AH1 D IY0|still S T IH1 L|learn L ER1 N|learned L ER1 N D|should SH UH0 D|world W ER1 L D|high HH AY1
every EH1 V R IY0|near N IH1 R|add AE1 D|food F UW1 D|between B IH0 T W IY1 N|own OW1 N|below B IH0 L OW1|country K AH1 N T R IY0
father F AA1 DH ER0|tree T R IY1|never N EH1 V ER0|start S T AA1 R T|city S IH1 T IY0|earth ER1 TH|eye AY1|eyes AY1 Z
light L AY1 T|thought TH AO1 T|head HH EH1 D|under AH1 N D ER0|story S T AO1 R IY0|saw S AO1|left L EH1 F T|few F Y UW1
while W AY1 L|along AH0 L AO1 NG|might M AY1 T|close K L OW1 Z|something S AH1 M TH IH0 NG|seem S IY1 M|next N EH1 K S T
hard HH AA1 R D|open OW1 P AH0 N|example IH0 G Z AE1 M P AH0 L|begin B IH0 G IH1 N|life L AY1 F|always AO1 L W EY0 Z
those DH OW1 Z|both B OW1 TH|paper P EY1 P ER0|together T AH0 G EH1 DH ER0|got G AA1 T|group G R UW1 P|often AO1 F AH0 N
run R AH1 N|important IH0 M P AO1 R T AH0 N T|until AH0 N T IH1 L|children CH IH1 L D R AH0 N|side S AY1 D|feet F IY1 T
car K AA1 R|mile M AY1 L|night N AY1 T|walk W AO1 K|white W AY1 T|sea S IY1|began B IH0 G AE1 N|grow G R OW1|took T UH1 K
river R IH1 V ER0|four F AO1 R|carry K AE1 R IY0|state S T EY1 T|once W AH1 N S|book B UH1 K|hear HH IH1 R|stop S T AA1 P
without W IH0 TH AW1 T|second S EH1 K AH0 N D|later L EY1 T ER0|idea AY0 D IY1 AH0|enough IH0 N AH1 F|eat IY1 T|face F EY1 S
watch W AA1 CH|far F AA1 R|really R IH1 L IY0|almost AO1 L M OW2 S T|let L EH1 T|above AH0 B AH1 V|girl G ER1 L
sometimes S AH1 M T AY2 M Z|mountain M AW1 N T AH0 N|cut K AH1 T|young Y AH1 NG|talk T AO1 K|soon S UW1 N|list L IH1 S T
song S AO1 NG|being B IY1 IH0 NG|leave L IY1 V|family F AE1 M AH0 L IY0|body B AA1 D IY0|music M Y UW1 Z IH0 K
color K AH1 L ER0|colour K AH1 L ER0|stand S T AE1 N D|sun S AH1 N|question K W EH1 S CH AH0 N|fish F IH1 SH
area EH1 R IY0 AH0|dog D AO1 G|horse HH AO1 R S|bird B ER1 D|problem P R AA1 B L AH0 M|complete K AH0 M P L IY1 T
room R UW1 M|knew N UW1|since S IH1 N S|ever EH1 V ER0|piece P IY1 S|told T OW1 L D|usually Y UW1 ZH AH0 W AH0 L IY0
friend F R EH1 N D|friends F R EH1 N D Z|easy IY1 Z IY0|heard HH ER1 D|order AO1 R D ER0|door D AO1 R|sure SH UH1 R
become B IH0 K AH1 M|ship SH IH1 P|across AH0 K R AO1 S|today T AH0 D EY1|during D UH1 R IH0 NG|short SH AO1 R T
better B EH1 T ER0|best B EH1 S T|however HH AW0 EH1 V ER0|low L OW1|hour AW1 ER0|hours AW1 ER0 Z|black B L AE1 K
whole HH OW1 L|measure M EH1 ZH ER0|remember R IH0 M EH1 M B ER0|early ER1 L IY0|listen L IH1 S AH0 N|wind W IH1 N D
space S P EY1 S|fast F AE1 S T|several S EH1 V R AH0 L|hold HH OW1 L D|himself HH IH0 M S EH1 L F|toward T AH0 W AO1 R D
five F AY1 V|morning M AO1 R N IH0 NG|true T R UW1|hundred HH AH1 N D R AH0 D|against AH0 G EH1 N S T|table T EY1 B AH0 L
north N AO1 R TH|money M AH1 N IY0|voice V OY1 S|woman W UH1 M AH0 N|women W IH1 M AH0 N|yes Y EH1 S|okay OW2 K EY1
ok OW2 K EY1|hello HH AH0 L OW1|welcome W EH1 L K AH0 M|please P L IY1 Z|thank TH AE1 NG K|thanks TH AE1 NG K S
video V IH1 D IY0 OW2|videos V IH1 D IY0 OW2 Z|movie M UW1 V IY0|film F IH1 L M|scene S IY1 N|shot SH AA1 T
camera K AE1 M ER0 AH0|beautiful B Y UW1 T AH0 F AH0 L|love L AH1 V|war W AO1 R|whose HH UW1 Z|whom HH UW1 M|gone G AO1 N
done D AH1 N|none N AH1 N|lose L UW1 Z|lost L AO1 S T|built B IH1 L T|build B IH1 L D|busy B IH1 Z IY0|business B IH1 Z N AH0 S
eight EY1 T|six S IH1 K S|seven S EH1 V AH0 N|nine N AY1 N|ten T EH1 N|zero Z IH1 R OW0|eleven IH0 L EH1 V AH0 N
twelve T W EH1 L V|thirteen TH ER1 T IY1 N|fourteen F AO1 R T IY1 N|fifteen F IH0 F T IY1 N|sixteen S IH0 K S T IY1 N
seventeen S EH1 V AH0 N T IY1 N|eighteen EY0 T IY1 N|nineteen N AY1 N T IY1 N|twenty T W EH1 N T IY0|thirty TH ER1 T IY0
forty F AO1 R T IY0|fifty F IH1 F T IY0|sixty S IH1 K S T IY0|seventy S EH1 V AH0 N T IY0|eighty EY1 T IY0|ninety N AY1 N T IY0
thousand TH AW1 Z AH0 N D|million M IH1 L Y AH0 N|billion B IH1 L Y AH0 N|trillion T R IH1 L Y AH0 N|percent P ER0 S EH1 N T
minus M AY1 N AH0 S|plus P L AH1 S|dollar D AA1 L ER0|dollars D AA1 L ER0 Z|pound P AW1 N D|pounds P AW1 N D Z|euro Y UH1 R OW0
euros Y UH1 R OW0 Z|pence P EH1 N S|cents S EH1 N T S|oh OW1|mister M IH1 S T ER0|missus M IH1 S IH0 Z|miz M IH1 Z|doctor D AA1 K T ER0
saint S EY1 N T|versus V ER1 S AH0 S|et EH1 T|cetera S EH1 T ER0 AH0|third TH ER1 D|fourth F AO1 R TH|fifth F IH1 F TH
eighth EY1 T TH|ninth N AY1 N TH|twelfth T W EH1 L F TH|don't D OW1 N T|can't K AE1 N T|won't W OW1 N T|isn't IH1 Z AH0 N T
aren't AA1 R AH0 N T|wasn't W AA1 Z AH0 N T|weren't W ER1 AH0 N T|doesn't D AH1 Z AH0 N T|didn't D IH1 D AH0 N T
haven't HH AE1 V AH0 N T|hasn't HH AE1 Z AH0 N T|hadn't HH AE1 D AH0 N T|couldn't K UH1 D AH0 N T|wouldn't W UH1 D AH0 N T
shouldn't SH UH1 D AH0 N T|i'm AY1 M|i've AY1 V|i'll AY1 L|i'd AY1 D|you're Y UH1 R|you've Y UW1 V|you'll Y UW1 L|you'd Y UW1 D
he's HH IY1 Z|she's SH IY1 Z|it's IH1 T S|we're W IH1 R|we've W IY1 V|we'll W IY1 L|they're DH EH1 R|they've DH EY1 V
they'll DH EY1 L|that's DH AE1 T S|there's DH EH1 R Z|what's W AH1 T S|let's L EH1 T S|here's HH IH1 R Z|who's HH UW1 Z
anyone EH1 N IY0 W AH2 N|everyone EH1 V R IY0 W AH2 N|someone S AH1 M W AH2 N|nothing N AH1 TH IH0 NG
everything EH1 V R IY0 TH IH2 NG|anything EH1 N IY0 TH IH2 NG|nobody N OW1 B AA2 D IY0|somebody S AH1 M B AA2 D IY0
tomorrow T AH0 M AA1 R OW2|yesterday Y EH1 S T ER0 D EY2|tonight T AH0 N AY1 T|already AO0 L R EH1 D IY0|though DH OW1
although AO2 L DH OW1|cough K AO1 F|rough R AH1 F|tough T AH1 F|laugh L AE1 F|bread B R EH1 D|heart HH AA1 R T
island AY1 L AH0 N D|iron AY1 ER0 N|ocean OW1 SH AH0 N|machine M AH0 SH IY1 N|police P AH0 L IY1 S|quite K W AY1 T
quiet K W AY1 AH0 T|guess G EH1 S|guide G AY1 D|huge HH Y UW1 JH|journey JH ER1 N IY0|minute M IH1 N AH0 T
minutes M IH1 N AH0 T S|sky S K AY1|sugar SH UH1 G ER0|truth T R UW1 TH|view V Y UW1|worse W ER1 S|worth W ER1 TH
tea T IY1|any EH1 N IY0|many M EH1 N IY0|half HH AE1 F|walked W AO1 K T|talked T AO1 K T|great G R EY1 T|break B R EY1 K
steak S T EY1 K|key K IY1|says S EH1 Z|friend F R EH1 N D|sword S AO1 R D|answer AE1 N S ER0|castle K AE1 S AH0 L
listen L IH1 S AH0 N|often AO1 F AH0 N|kokoro K AH0 K AO1 R OW0|tomlin T AA1 M L IH0 N|english IH1 NG G L IH0 SH
brown B R AW1 N|town T AW1 N|crowd K R AW1 D|character K EH1 R IH0 K T ER0|characters K EH1 R IH0 K T ER0 Z
chorus K AO1 R AH0 S|chaos K EY1 AA2 S|school S K UW1 L|adventure AE0 D V EH1 N CH ER0|data D EY1 T AH0|online AA2 N L AY1 N|website W EH1 B S AY2 T|email IY1 M EY2 L|computer K AH0 M P Y UW1 T ER0`;

const WORDS = new Map<string, string[]>();
for (const entry of LIST.split(/[|\n]/)) {
  const [w, ...sounds] = entry.trim().split(/\s+/);
  if (w) WORDS.set(w, sounds);
}

/** Letter names, for a short word in capitals that is spelled out (TV, BBC). */
const LETTERS: Record<string, string> = {
  A: 'EY1', B: 'B IY1', C: 'S IY1', D: 'D IY1', E: 'IY1', F: 'EH1 F', G: 'JH IY1', H: 'EY1 CH', I: 'AY1', J: 'JH EY1', K: 'K EY1', L: 'EH1 L', M: 'EH1 M',
  N: 'EH1 N', O: 'OW1', P: 'P IY1', Q: 'K Y UW1', R: 'AA1 R', S: 'EH1 S', T: 'T IY1', U: 'Y UW1', V: 'V IY1', W: 'D AH1 B AH0 L Y UW0', X: 'EH1 K S', Y: 'W AY1', Z: 'Z IY1',
};

// ---- Letter-to-sound rules (NRL, 1976) ----
// [left, letters, right, sounds]. In a context: ' ' the edge of the word, # one or more vowels, : none or more
// consonants, ^ one consonant, . a voiced consonant (B D V G J L M N R W Z), + E I or Y, & a hissing sound (S C G Z X
// J CH SH), @ a consonant before a long U (T S R D L Z N J TH CH SH), % an ending (ER E ES ED ING ELY). Sounds:
// two capitals are a vowel or a two-letter consonant (AX the schwa), one small letter a consonant (j as in jam, y as in yes).

type Rule = [string, string, string, string];
const R: Record<string, Rule[]> = {
  A: [['', 'A', ' ', 'AX'], [' ', 'ARE', ' ', 'AAr'], [' ', 'AR', 'O', 'AXr'], ['', 'AR', '#', 'EHr'], ['^', 'AS', '#', 'EYs'], ['', 'A', 'WA', 'AX'], ['', 'AW', '', 'AO'],
    [' :', 'ANY', '', 'EHnIY'], ['', 'A', '^+#', 'EY'], ['#:', 'ALLY', '', 'AXlIY'], [' ', 'AL', '#', 'AXl'], ['', 'AGAIN', '', 'AXgEHn'], ['#:', 'AG', 'E', 'IHj'],
    ['', 'A', '^+:#', 'AE'], [' :', 'A', '^+ ', 'EY'], ['', 'A', '^%', 'EY'], [' ', 'ARR', '', 'AXr'], ['', 'ARR', '', 'AEr'], [' :', 'AR', ' ', 'AAr'], ['', 'AR', ' ', 'ER'],
    ['', 'AR', '', 'AAr'], ['', 'AIR', '', 'EHr'], ['', 'AI', '', 'EY'], ['', 'AY', '', 'EY'], ['', 'AU', '', 'AO'], ['#:', 'AL', ' ', 'AXl'], ['#:', 'ALS', ' ', 'AXlz'],
    ['', 'ALK', '', 'AOk'], ['', 'AL', '^', 'AOl'], [' :', 'ABLE', '', 'EYbAXl'], ['', 'ABLE', '', 'AXbAXl'], ['', 'ANG', '+', 'EYnj'], ['', 'A', '', 'AE']],
  B: [[' ', 'BE', '^#', 'bIH'], ['', 'BEING', '', 'bIYIHNG'], [' ', 'BOTH', ' ', 'bOWTH'], [' ', 'BUS', '#', 'bIHz'], ['', 'BUIL', '', 'bIHl'], ['', 'B', '', 'b']],
  C: [[' ', 'CH', '^', 'k'], ['^E', 'CH', '', 'k'], ['', 'CH', '', 'CH'], [' S', 'CI', '#', 'sAY'], ['', 'CI', 'A', 'SH'], ['', 'CI', 'O', 'SH'], ['', 'CI', 'EN', 'SH'],
    ['', 'C', '+', 's'], ['', 'CK', '', 'k'], ['', 'COM', '%', 'kAHm'], ['', 'C', '', 'k']],
  D: [['#:', 'DED', ' ', 'dIHd'], ['.E', 'D', ' ', 'd'], ['#:^E', 'D', ' ', 't'], [' ', 'DE', '^#', 'dIH'], [' ', 'DO', ' ', 'dUW'], [' ', 'DOES', '', 'dAHz'],
    [' ', 'DOING', '', 'dUWIHNG'], [' ', 'DOW', '', 'dAW'], ['', 'DU', 'A', 'jUW'], ['', 'D', '', 'd']],
  E: [['#:', 'E', ' ', ''], ['\'^:', 'E', ' ', ''], [' :', 'E', ' ', 'IY'], ['#', 'ED', ' ', 'd'], ['#:', 'E', 'D ', ''], ['', 'EV', 'ER', 'EHv'], ['', 'E', '^%', 'IY'],
    ['', 'ERI', '#', 'IYrIY'], ['', 'ERI', '', 'EHrIH'], ['#:', 'ER', '#', 'ER'], ['', 'ER', '#', 'EHr'], ['', 'ER', '', 'ER'], [' ', 'EVEN', '', 'IYvEHn'], ['#:', 'E', 'W', ''],
    ['@', 'EW', '', 'UW'], ['', 'EW', '', 'yUW'], ['', 'E', 'O', 'IY'], ['#:&', 'ES', ' ', 'IHz'], ['#:', 'E', 'S ', ''], ['#:', 'ELY', ' ', 'lIY'], ['#:', 'EMENT', '', 'mEHnt'],
    ['', 'EFUL', '', 'fUHl'], ['', 'EE', '', 'IY'], ['', 'EARN', '', 'ERn'], [' ', 'EAR', '^', 'ER'], ['', 'EAD', '', 'EHd'], ['#:', 'EA', ' ', 'IYAX'], ['', 'EA', 'SU', 'EH'],
    ['', 'EA', '', 'IY'], ['', 'EIGH', '', 'EY'], ['', 'EI', '', 'IY'], [' ', 'EYE', '', 'AY'], ['', 'EY', '', 'IY'], ['', 'EU', '', 'yUW'], ['', 'E', '', 'EH']],
  F: [['', 'FUL', '', 'fUHl'], ['', 'F', '', 'f']],
  G: [['', 'GIV', '', 'gIHv'], [' ', 'G', 'I^', 'g'], ['', 'GE', 'T', 'gEH'], ['SU', 'GGES', '', 'gjEHs'], ['', 'GG', '', 'g'], [' B#', 'G', '', 'g'], ['', 'G', '+', 'j'],
    ['', 'GREAT', '', 'grEYt'], ['#', 'GH', '', ''], ['', 'G', '', 'g']],
  H: [[' ', 'HAV', '', 'hAEv'], [' ', 'HERE', '', 'hIYr'], [' ', 'HOUR', '', 'AWER'], ['', 'HOW', '', 'hAW'], ['', 'H', '#', 'h'], ['', 'H', '', '']],
  I: [[' ', 'IN', '', 'IHn'], [' ', 'I', ' ', 'AY'], ['', 'IN', 'D', 'AYn'], ['', 'IER', '', 'IYER'], ['#:R', 'IED', '', 'IYd'], ['', 'IED', ' ', 'AYd'], ['', 'IEN', '', 'IYEHn'],
    ['', 'IE', 'T', 'AYEH'], [' :', 'I', '%', 'AY'], ['', 'I', '%', 'IY'], ['', 'IE', '', 'IY'], ['', 'I', '^+:#', 'IH'], ['', 'IR', '#', 'AYr'], ['', 'IZ', '%', 'AYz'],
    ['', 'IS', '%', 'AYz'], ['', 'I', 'D%', 'AY'], ['+^', 'I', '^+', 'IH'], ['', 'I', 'T%', 'AY'], ['#:^', 'I', '^+', 'IH'], ['', 'I', '^+', 'AY'], ['', 'IR', '', 'ER'],
    ['', 'IGH', '', 'AY'], ['', 'ILD', '', 'AYld'], ['', 'IGN', ' ', 'AYn'], ['', 'IGN', '^', 'AYn'], ['', 'IGN', '%', 'AYn'], ['', 'IQUE', '', 'IYk'], ['', 'I', '', 'IH']],
  J: [['', 'J', '', 'j']],
  K: [[' ', 'K', 'N', ''], ['', 'K', '', 'k']],
  L: [['', 'LO', 'C#', 'lOW'], ['L', 'L', '', ''], ['#:^', 'L', '%', 'AXl'], ['', 'LEAD', '', 'lIYd'], ['', 'L', '', 'l']],
  M: [['', 'MOV', '', 'mUWv'], ['', 'M', '', 'm']],
  N: [['E', 'NG', '+', 'nj'], ['', 'NG', 'R', 'NGg'], ['', 'NG', '#', 'NGg'], ['', 'NGL', '%', 'NGgAXl'], ['', 'NG', '', 'NG'], ['', 'NK', '', 'NGk'], [' ', 'NOW', ' ', 'nAW'],
    ['', 'N', '', 'n']],
  O: [['', 'OF', ' ', 'AXv'], ['', 'OROUGH', '', 'EROW'], ['#:', 'OR', ' ', 'ER'], ['#:', 'ORS', ' ', 'ERz'], ['', 'OR', '', 'AOr'], [' ', 'ONE', '', 'wAHn'], ['', 'OW', '', 'OW'],
    [' ', 'OVER', '', 'OWvER'], ['', 'OV', '', 'AHv'], ['', 'O', '^%', 'OW'], ['', 'O', '^EN', 'OW'], ['', 'O', '^I#', 'OW'], ['', 'OL', 'D', 'OWl'], ['', 'OUGHT', '', 'AOt'],
    ['', 'OUGH', '', 'AHf'], [' ', 'OU', '', 'AW'], ['H', 'OU', 'S#', 'AW'], ['', 'OUS', '', 'AXs'], ['', 'OUR', '', 'AOr'], ['', 'OULD', '', 'UHd'], ['^', 'OU', '^L', 'AH'],
    ['', 'OUP', '', 'UWp'], ['', 'OU', '', 'AW'], ['', 'OY', '', 'OY'], ['', 'OING', '', 'OWIHNG'], ['', 'OI', '', 'OY'], ['', 'OOR', '', 'AOr'], ['', 'OOK', '', 'UHk'],
    ['', 'OOD', '', 'UHd'], ['', 'OO', '', 'UW'], ['', 'O', 'E', 'OW'], ['', 'O', ' ', 'OW'], ['', 'OA', '', 'OW'], [' ', 'ONLY', '', 'OWnlIY'], [' ', 'ONCE', '', 'wAHns'],
    ['', 'ON\'T', '', 'OWnt'], ['C', 'O', 'N', 'AA'], ['', 'O', 'NG', 'AO'], [' :^', 'O', 'N', 'AH'], ['I', 'ON', '', 'AXn'], ['#:', 'ON', ' ', 'AXn'], ['#^', 'ON', '', 'AXn'],
    ['', 'O', 'ST ', 'OW'], ['', 'OF', '^', 'AOf'], ['', 'OTHER', '', 'AHDHER'], ['', 'OSS', ' ', 'AOs'], ['#:^', 'OM', '', 'AHm'], ['', 'O', '', 'AA']],
  P: [['', 'PH', '', 'f'], ['', 'PEOP', '', 'pIYp'], ['', 'POW', '', 'pAW'], ['', 'PUT', ' ', 'pUHt'], ['', 'P', '', 'p']],
  Q: [['', 'QUAR', '', 'kwAOr'], ['', 'QU', '', 'kw'], ['', 'Q', '', 'k']],
  R: [[' ', 'RE', '^#', 'rIY'], ['', 'R', '', 'r']],
  S: [['', 'SH', '', 'SH'], ['#', 'SION', '', 'ZHAXn'], ['', 'SOME', '', 'sAHm'], ['#', 'SUR', '#', 'ZHER'], ['', 'SUR', '#', 'SHER'], ['#', 'SU', '#', 'ZHUW'],
    ['#', 'SSU', '#', 'SHUW'], ['#', 'SED', ' ', 'zd'], ['#', 'S', '#', 'z'], ['', 'SAID', '', 'sEHd'], ['^', 'SION', '', 'SHAXn'], ['', 'S', 'S', ''], ['.', 'S', ' ', 'z'],
    ['#:.E', 'S', ' ', 'z'], ['#:^##', 'S', ' ', 'z'], ['#:^#', 'S', ' ', 's'], ['U', 'S', ' ', 's'], [' :#', 'S', ' ', 'z'], [' ', 'SCH', '', 'sk'], ['', 'S', 'C+', ''],
    ['#', 'SM', '', 'zm'], ['#', 'SN', '\'', 'zAXn'], ['', 'S', '', 's']],
  T: [[' ', 'THE', ' ', 'DHAX'], ['', 'TO', ' ', 'tUW'], ['', 'THAT', ' ', 'DHAEt'], [' ', 'THIS', ' ', 'DHIHs'], [' ', 'THEY', '', 'DHEY'], [' ', 'THERE', '', 'DHEHr'],
    ['', 'THER', '', 'DHER'], ['', 'THEIR', '', 'DHEHr'], [' ', 'THAN', ' ', 'DHAEn'], [' ', 'THEM', ' ', 'DHEHm'], ['', 'THESE', ' ', 'DHIYz'], [' ', 'THEN', '', 'DHEHn'],
    ['', 'THROUGH', '', 'THrUW'], ['', 'THOSE', '', 'DHOWz'], ['', 'THOUGH', ' ', 'DHOW'], [' ', 'THUS', '', 'DHAHs'], ['', 'TH', '', 'TH'], ['#:', 'TED', ' ', 'tIHd'],
    ['S', 'TI', '#N', 'CH'], ['', 'TI', 'O', 'SH'], ['', 'TI', 'A', 'SH'], ['', 'TIEN', '', 'SHAXn'], ['', 'TUR', '#', 'CHER'], ['', 'TU', 'A', 'CHUW'], [' ', 'TWO', '', 'tUW'],
    ['', 'T', '', 't']],
  U: [[' ', 'UN', 'I', 'yUWn'], [' ', 'UN', '', 'AHn'], [' ', 'UPON', '', 'AXpAOn'], ['@', 'UR', '#', 'UHr'], ['', 'UR', '#', 'yUHr'], ['', 'UR', '', 'ER'], ['', 'U', '^ ', 'AH'],
    ['', 'U', '^^', 'AH'], ['', 'UY', '', 'AY'], [' G', 'U', '#', ''], ['G', 'U', '%', ''], ['G', 'U', '#', 'w'], ['#N', 'U', '', 'yUW'], ['@', 'U', '', 'UW'], ['', 'U', '', 'yUW']],
  V: [['', 'VIEW', '', 'vyUW'], ['', 'V', '', 'v']],
  W: [[' ', 'WERE', '', 'wER'], ['', 'WA', 'S', 'wAA'], ['', 'WA', 'T', 'wAA'], ['', 'WHERE', '', 'wEHr'], ['', 'WHAT', '', 'wAAt'], ['', 'WHOL', '', 'hOWl'], ['', 'WHO', '', 'hUW'],
    ['', 'WH', '', 'w'], ['', 'WAR', '', 'wAOr'], ['', 'WOR', '^', 'wER'], ['', 'WR', '', 'r'], ['', 'W', '', 'w']],
  X: [['', 'X', '', 'ks']],
  Y: [['', 'YOUNG', '', 'yAHNG'], [' ', 'YOU', '', 'yUW'], [' ', 'YES', '', 'yEHs'], [' ', 'Y', '', 'y'], ['#:^', 'Y', ' ', 'IY'], ['#:^', 'Y', 'I', 'IY'], [' :', 'Y', ' ', 'AY'],
    [' :', 'Y', '#', 'AY'], [' :', 'Y', '^+:#', 'IH'], [' :', 'Y', '^#', 'AY'], ['', 'Y', '', 'IH']],
  Z: [['', 'Z', '', 'z']],
};

const VOWEL = /[AEIOU]/;
const CONSONANT = /[BCDFGHJKLMNPQRSTVWXYZ]/;
const isLetter = (c: string | undefined) => !!c && /[A-Z]/.test(c);

/** Whether `ctx` matches the letters before `pos` (read backwards from it). */
function leftOk(ctx: string, w: string, pos: number): boolean {
  for (let k = ctx.length - 1; k >= 0; k--) {
    const c = ctx[k];
    const ch = w[pos];
    switch (c) {
      case ' ': if (isLetter(ch)) return false; pos--; break;
      case '#': if (!ch || !VOWEL.test(ch)) return false; while (w[pos] && VOWEL.test(w[pos])) pos--; break;
      case ':': while (w[pos] && CONSONANT.test(w[pos])) pos--; break;
      case '^': if (!ch || !CONSONANT.test(ch)) return false; pos--; break;
      case '.': if (!ch || !'BDVGJLMNRWZ'.includes(ch)) return false; pos--; break;
      case '+': if (!ch || !'EIY'.includes(ch)) return false; pos--; break;
      case '&': if (ch === 'H' && 'CS'.includes(w[pos - 1] ?? '-')) pos -= 2; else if (ch && 'SCGZXJ'.includes(ch)) pos--; else return false; break;
      case '@': if (ch === 'H' && 'TCS'.includes(w[pos - 1] ?? '-')) pos -= 2; else if (ch && 'TSRDLZNJ'.includes(ch)) pos--; else return false; break;
      default: if (ch !== c) return false; pos--;
    }
  }
  return true;
}

/** Whether `ctx` matches the letters from `pos` on. */
function rightOk(ctx: string, w: string, pos: number): boolean {
  for (const c of ctx) {
    const ch = w[pos];
    switch (c) {
      case ' ': if (isLetter(ch)) return false; pos++; break;
      case '#': if (!ch || !VOWEL.test(ch)) return false; while (w[pos] && VOWEL.test(w[pos])) pos++; break;
      case ':': while (w[pos] && CONSONANT.test(w[pos])) pos++; break;
      case '^': if (!ch || !CONSONANT.test(ch)) return false; pos++; break;
      case '.': if (!ch || !'BDVGJLMNRWZ'.includes(ch)) return false; pos++; break;
      case '+': if (!ch || !'EIY'.includes(ch)) return false; pos++; break;
      case '&': if ('CS'.includes(ch ?? '-') && w[pos + 1] === 'H') pos += 2; else if (ch && 'SCGZXJ'.includes(ch)) pos++; else return false; break;
      case '@': if ('TCS'.includes(ch ?? '-') && w[pos + 1] === 'H') pos += 2; else if (ch && 'TSRDLZNJ'.includes(ch)) pos++; else return false; break;
      case '%':
        if (ch === 'E') {
          pos++;
          if (w[pos] === 'L' && w[pos + 1] === 'Y') pos += 2;
          else if (w[pos] && 'RSD'.includes(w[pos])) pos++;
        } else if (w.startsWith('ING', pos)) pos += 3;
        else return false;
        break;
      default: if (ch !== c) return false; pos++;
    }
  }
  return true;
}

const TWO = new Set(['AX', 'AA', 'AE', 'AH', 'AO', 'AW', 'AY', 'EH', 'ER', 'EY', 'IH', 'IY', 'OW', 'OY', 'UH', 'UW', 'CH', 'SH', 'TH', 'DH', 'ZH', 'NG']);
const SMALL: Record<string, string> = { b: 'B', d: 'D', f: 'F', g: 'G', h: 'HH', j: 'JH', k: 'K', l: 'L', m: 'M', n: 'N', p: 'P', r: 'R', s: 'S', t: 'T', v: 'V', w: 'W', y: 'Y', z: 'Z' };

/** The rules' sounds for one word (capitals, apostrophes kept), as CMU-style sounds without stress. */
export function ruleSounds(word: string): string[] {
  const w = ` ${word.toUpperCase().replace(/[^A-Z']/g, '')} `;
  let out = '';
  for (let i = 1; i < w.length - 1;) {
    const rules = R[w[i]];
    if (!rules) {
      i++;
      continue;
    }
    const hit = rules.find(([l, m, r]) => w.startsWith(m, i) && leftOk(l, w, i - 1) && rightOk(r, w, i + m.length));
    if (!hit) {
      i++;
      continue;
    }
    out += hit[3];
    i += hit[1].length;
  }
  const sounds: string[] = [];
  const push = (s: string) => {
    // A doubled letter is one sound (apple, little): never the same consonant twice running.
    if (!VOWELS.has(s) && sounds[sounds.length - 1] === s) return;
    sounds.push(s);
  };
  for (let i = 0; i < out.length;) {
    const two = out.slice(i, i + 2);
    if (TWO.has(two)) {
      push(two);
      i += 2;
    } else {
      if (SMALL[out[i]]) push(SMALL[out[i]]);
      i++;
    }
  }
  return sounds;
}

const VOWELS = new Set(['AX', 'AA', 'AE', 'AH', 'AO', 'AW', 'AY', 'EH', 'ER', 'EY', 'IH', 'IY', 'OW', 'OY', 'UH', 'UW']);

// Endings that put the stress on the syllable before them: [ending, its syllables].
const STRESS_BEFORE: [RegExp, number][] = [
  [/(?:tion|sion|cian|tial|cial|cious|tious|gious|xious|geous)s?$/, 1], [/(?:ically)$/, 3], [/(?:ical|ity|ety|ogy|ian|ial|ium|ior|ious|eous|uous|raphy|ative|itive|ia|ient|ience)s?$/, 2],
  [/(?:ic|ics|ish)$/, 1],
];
const STRESS_LAST = /(?:ee|eer|ese|ique|oon|ette|esque|ade)s?$/;
/** Beginnings that are seldom stressed: the stress moves past each (at most two, as in un-ex-pected). */
const UNSTRESSED_START = /^(?:be|de|re|ex|dis|mis|en|em|un|con|com|ob|sub|pre|pro)(?=[a-z]{3,})/;

/** Stress put on the rules' sounds of `word` (spelled as typed): 1 on one vowel, 0 on the rest. */
export function withStress(word: string, sounds: string[]): string[] {
  const at = sounds.map((s, i) => (VOWELS.has(s) ? i : -1)).filter(i => i >= 0);
  if (!at.length) return sounds;
  const w = word.toLowerCase();
  let pick = 0;
  const before = STRESS_BEFORE.find(([re]) => re.test(w));
  if (at.length === 1) pick = 0;
  else if (before) pick = Math.max(0, at.length - 1 - before[1]);
  else if (STRESS_LAST.test(w)) pick = at.length - 1;
  else {
    let rest = w;
    for (let n = 0; n < 2 && pick < at.length - 1; n++) {
      const m = UNSTRESSED_START.exec(rest);
      if (!m) break;
      pick++;
      rest = rest.slice(m[0].length);
    }
    // Two syllables ending as a noun or a describing word often does (a "-er", "-y", "-le" word) keep the first.
    if (at.length === 2 && /(?:er|y|le|ow|ing|ed|en|ly)$/.test(w)) pick = 0;
  }
  // A schwa takes no stress: the next full vowel does, else the one before.
  while (pick < at.length - 1 && sounds[at[pick]] === 'AX') pick++;
  while (pick > 0 && sounds[at[pick]] === 'AX') pick--;
  const out = sounds.map(s => (VOWELS.has(s) ? `${s === 'AX' ? 'AH' : s}0` : s));
  const v = sounds[at[pick]];
  out[at[pick]] = `${v === 'AX' ? 'AH' : v}1`;
  // A long word stressed late gets a lighter stress on its first full vowel.
  if (at.length >= 4 && pick >= 2 && sounds[at[0]] !== 'AX') out[at[0]] = `${sounds[at[0]]}2`;
  return out;
}

// ---- CMU-style sounds to Kokoro's symbols ----

const IPA: Record<string, string> = {
  AA: 'ɑ', AE: 'æ', AH: 'ʌ', AO: 'ɔ', AW: 'W', AY: 'I', EH: 'ɛ', ER: 'ɜɹ', EY: 'A', IH: 'ɪ', IY: 'i', OW: 'O', OY: 'Y', UH: 'ʊ', UW: 'u',
  B: 'b', CH: 'ʧ', D: 'd', DH: 'ð', F: 'f', G: 'ɡ', HH: 'h', JH: 'ʤ', K: 'k', L: 'l', M: 'm', N: 'n', NG: 'ŋ', P: 'p', R: 'ɹ', S: 's',
  SH: 'ʃ', T: 't', TH: 'θ', V: 'v', W: 'w', Y: 'j', Z: 'z', ZH: 'ʒ',
};
const PRIMARY = 'ˈ';
const SECONDARY = 'ˌ';

/** CMU-style sounds ("HH AH0 L OW1") as Kokoro reads them ("həlˈO"): the stress mark goes just before its vowel. */
export function toKokoro(sounds: string[]): string {
  let out = '';
  for (const s of sounds) {
    const m = /^([A-Z]+)([012])?$/.exec(s);
    if (!m) continue;
    const [, p, stress] = m;
    if (stress === undefined) {
      out += IPA[p] ?? '';
      continue;
    }
    const mark = stress === '1' ? PRIMARY : stress === '2' ? SECONDARY : '';
    // Unstressed: AH is the schwa, ER the schwa before R.
    const said = stress === '0' && p === 'AH' ? 'ə' : stress === '0' && p === 'ER' ? 'əɹ' : IPA[p] ?? '';
    out += mark + said;
  }
  return out;
}

const HISS = /(?:S|Z|SH|ZH|CH|JH)$/;
const VOICELESS = /(?:P|T|K|F|TH)$/;

/** One word's sounds (CMU-style, with stress): the list, the list plus an ending, a short word in capitals spelled, else the rules. */
export function wordSounds(raw: string): string[] {
  const word = raw.replace(/[’]/g, '\'');
  const low = word.toLowerCase();
  const listed = WORDS.get(low);
  if (listed) return listed;
  // TV, BBC, USA: two to four capitals that are not a listed word are said letter by letter.
  if (/^[A-Z]{2,4}$/.test(word) && (!/[AEIOU]/.test(word) || word.length <= 3)) return word.split('').flatMap(c => LETTERS[c].split(' '));
  // The list's words with an ending: 's, s, es, ed, ing, ly.
  const base = (end: string) => (low.endsWith(end) ? WORDS.get(low.slice(0, -end.length)) : undefined);
  const ends = (b: string[], sound: 'z' | 'd'): string[] => {
    const last = b.join(' ');
    if (sound === 'z') return [...b, ...(HISS.test(last) ? ['IH0', 'Z'] : VOICELESS.test(last) ? ['S'] : ['Z'])];
    return [...b, ...(/(?:T|D)$/.test(last) ? ['IH0', 'D'] : /(?:P|K|F|TH|S|SH|CH)$/.test(last) ? ['T'] : ['D'])];
  };
  for (const end of ['\'s', 's\'', 's']) {
    const b = base(end);
    if (b) return ends(b, 'z');
  }
  const es = base('es');
  if (es) return [...es, 'IH0', 'Z'];
  const ed = base('ed') ?? base('d');
  if (ed) return ends(ed, 'd');
  const ing = base('ing') ?? (low.endsWith('ing') ? WORDS.get(`${low.slice(0, -3)}e`) : undefined);
  if (ing) return [...ing, 'IH0', 'NG'];
  const ly = base('ly');
  if (ly) return [...ly, 'L', 'IY0'];
  // 's on a word the rules read.
  if (/'s$/i.test(word)) {
    const b = withStress(word.slice(0, -2), ruleSounds(word.slice(0, -2)));
    return ends(b, 'z');
  }
  return withStress(word, ruleSounds(word));
}

/** Kokoro's punctuation, kept between the words. */
const MARKS = ';:,.!?—…';

/**
 * Text (one sentence or a few) as Kokoro's symbols: words split by spaces, the punctuation it knows kept after its
 * word. Text should have been through sayInWords first (digits are dropped here).
 */
export function phonemize(text: string): string {
  const parts = text.replace(/[()[\]{}]/g, ',').match(/[A-Za-z]+(?:['’][A-Za-z]+)*|[;:,.!?—…]/g) ?? [];
  let out = '';
  for (const p of parts) {
    if (MARKS.includes(p)) {
      // No mark at the very start, and never two commas running.
      if (!out || (p === ',' && /[;:,.!?—…] $/.test(out))) continue;
      // A stronger mark after a comma takes its place ("there,!" is "there!").
      out = out.replace(/ $/, '').replace(/,$/, '') + p + ' ';
      continue;
    }
    const said = toKokoro(wordSounds(p));
    if (said) out += `${said} `;
  }
  return out.trim();
}
