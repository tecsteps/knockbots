# Character visual target — "Robot Combat Roster" reference

The eight 1536×1024 character sheets supplied as reference (`aegis-01`, `vesper`,
`volt-monk`, `furnace`, `paladin`, `neon-ronin`, `atlas-7`, `ghostframe`) are the
target look for every fighter in the cast. This file is the contract: it names
the grammar they share, the things the current build gets wrong, and which sheet
each of the ten roster fighters is built to.

It is written from the images, not from a description of them. Where a number
appears it was read off a pose panel, not invented.

---

## 1. The grammar all eight share

These are the things that are true of every sheet. They are the look; the
per-character differences in §3 are decoration on top of them.

### 1.1 Anatomy, not boxes

Every one of the eight is an **anatomical humanoid**, not a walking crate. Read
the silhouettes with the detail thrown away and you get a human figure: deltoid
ball, tapering upper arm, forearm that swells at the brachioradialis and necks
down to a narrow wrist, a chest that is wider than the waist, a thigh mass that
is the widest part of the leg, a calf belly high on the shank, a narrow ankle.

The shapes carrying that anatomy are **curved shells**, not slabs:

- Limb segments are **tapered capsules** — an ovoid cross-section that changes
  width along its length. A limb is never a constant-width box.
- Every plate is a **section of a swept surface**. It curves in two directions.
  Flat faces appear only as small deliberate facets (a knee cap, a shin plate's
  central ridge), never as the primary form.
- Plates **wrap** the limb: they cover roughly the outer 200–260° of the segment
  and leave the inner face open to the dark underskin (§1.3).

The current build fails this first and hardest. `03-full-body.jpg` shows two
fighters made of constant-width rectangular prisms with square shoulders, square
forearms and slab thighs. No amount of surfacing rescues that silhouette.

### 1.2 Proportions

Measured off the front-facing panel of each sheet, in head-heights:

| | total height | shoulder span | waist | thigh Ø | ankle Ø |
|---|---|---|---|---|---|
| light frames (vesper, ghostframe, volt monk) | 7.5–8 heads | 2.0–2.2 heads | 0.75 × chest | 0.9 head | 0.35 head |
| mid frames (paladin, neon ronin) | 7.0–7.5 heads | 2.4–2.6 heads | 0.80 × chest | 1.0 head | 0.40 head |
| heavy frames (aegis-01, furnace) | 6.0–6.5 heads | 3.0–3.4 heads | 0.90 × chest | 1.3 heads | 0.50 head |
| super-heavy (atlas-7) | 5.5 heads | 3.6 heads | 0.95 × chest | 1.5 heads | 0.55 head |

Two consequences the current build violates:

- **The head is small.** Even on the heavies it is ~1/6 of total height. The
  current heads are far too large and far too cubic.
- **Hands and feet are human-scaled.** A fist is about one head wide, not two.
  The current mitten blocks are roughly double.

### 1.3 The dark underskin

Under the painted armour there is a **second, darker body**: a matte
charcoal/graphite layer of ribbed segments, braided bundles and stacked discs.
It is visible in a consistent set of places on all eight sheets:

- the **neck** — always exposed, always ribbed or cabled, never covered;
- the **armpit and inner shoulder** — the deltoid shell floats clear of it;
- the **waist / lower abdomen** — a segmented stack of rings between chest and
  pelvis, most visible on `volt-monk` and `ghostframe`;
- the **inner elbow and back of the knee**;
- the **inner thigh and behind the ankle**;
- the **finger and toe joints**.

This is the single biggest reason the sheets read as *machines* rather than as
armour suits: the eye sees armour, then a gap, then mechanism, at every joint.
It is also what makes the joints look like they can move.

### 1.4 Joint hardware

Every major joint has **visible circular hardware** at its pivot, standing proud
of the shells around it:

- shoulder, elbow, hip, knee, ankle and wrist all carry a **disc or bezel** on
  the joint axis, concentric rings, usually in the trim metal;
- the disc is **larger than half the limb width**, so it is still the read at any
  flex angle;
- on `vesper`, `atlas-7` and `volt-monk` the bezels are brass/gold and are the
  character's second colour;
- knee and elbow additionally carry a floating **cap plate** that overlaps the
  segment above.

### 1.5 Hands and feet

**Hands are fully articulated.** Four fingers plus an opposed thumb, each finger
three segments, each segment its own small capsule with a dark knuckle gap. The
close-up panels on `aegis-01`, `volt-monk`, `paladin`, `vesper` and `atlas-7` all
devote a whole tile to the hand — it is a hero element, not a mitten. Fists are
formed by curling those fingers, and the knuckle row is a hard bright edge.

**Feet are segmented.** A heel block, a mid plate, and two to four separate toe
plates with visible gaps between them, sized like a boot rather than like a ski.
Ankle carries the same rotary bezel as the other joints.

### 1.6 Surfacing

The paint is **clean automotive**, not weathered scrap:

- a strong **clearcoat** — every sheet has crisp, tight specular highlights and
  visible reflected environment on the large plates;
- **panel lines are thin, dark and sparse** — a handful of deliberate splits per
  plate, following the form, not a uniform grid;
- **wear is edge-only** — a bright line of exposed metal on a leading edge, a
  couple of chips. `furnace` and `atlas-7` are the two dirty ones and even they
  keep grime in crevices rather than smeared over faces;
- **no all-over noise, no diagonal hatch, no repeating carbon weave** on the
  primary plates. The current build's plates are covered in it and it destroys
  the material read;
- **trim metal is polished** — brass, gold or nickel, high specular, low
  roughness, used on rings, rims, fasteners and edge breaks only;
- **emissive is thin and linear** — light lives in narrow grooves between plates,
  in the visor, and in one hero element (chest core, spine, halo). It is never a
  large glowing face.

### 1.7 Heads

Small, smooth, and built on one of two plans:

- **domed/ovoid** (`volt-monk`, `vesper`, `ghostframe`, `atlas-7`) — an egg with
  a facial groove or lens cluster, no jaw, no mouth;
- **helmeted** (`aegis-01`, `paladin`, `neon-ronin`, `furnace`) — a brow band, a
  cheek plate, a visor slit, and a crest or horn pair.

In both cases the **eye is a narrow emissive slit or a pair of lenses**, and the
head sits on an **exposed cabled neck** with a clear gap to the chest.

---

## 2. What the current build does wrong

From `docs/shots/01-hero-idle.jpg` and `03-full-body.jpg`:

1. Silhouette is orthogonal — square shoulders, square forearms, square thighs.
2. Limbs are constant-width; nothing tapers.
3. Hands are mittens; feet are ski-sized slabs.
4. Heads are cubes and are ~1.5× too large.
5. No dark underskin anywhere; the body has no visible mechanism between plates.
6. Joints have no circular hardware standing proud of the limb.
7. Surfacing is all-over grunge and diagonal hatch; no clearcoat read, no
   polished trim, no edge-only wear.
8. Emissive is broad panels rather than thin grooves.

---

## 3. Sheet assignment

Ten fighters, eight sheets. Eight fighters are built directly to a sheet; two are
derived inside the same design language, because deleting two fighters and their
move tables is not a visual change.

| fighter | sheet | what carries over | what changes |
|---|---|---|---|
| **VULKAN** | `furnace` | brutalist riveted heavy, slot-visor helmet, glowing rib vents, boxier-than-the-rest plates | keeps its scorched-iron / molten-orange palette (already the sheet's palette) |
| **BASTION** | `paladin` | knight crest helm, heraldic chest shield, layered ivory plates over navy underlayer | ivory → gunmetal blue primary, red accents → sector blue |
| **VOLTA** | `aegis-01` | industrial heavyweight, huge rounded pauldrons, thick capsule limbs, riveted panels | blue/orange → burnished copper / brass, arc-white emissive |
| **ANVIL** | `atlas-7` | retro diving-suit super-heavy, spherical shoulder bosses with wheel hubs, coil-spring spine, goggle head | olive → safety yellow, brass trim stays |
| **AXIOM** | `volt-monk` | smooth featureless ovoid head, arc-reactor chest disc, exposed brass spine, cleanest surfacing in the cast | brass → anodised grey-green, cyan → mint |
| **NYX** | `vesper` | glossy black slim frame, gold ring bezels at every joint, violet edge glow | violet → magenta, adds lantern-head lens |
| **SERAPH** | `ghostframe` | pearl-iridescent slim acrobat, halo ring behind the head, dorsal blade fins, dark ribbed spine | pearl → porcelain, halo/fins tinted violet |
| **RONIN-07** | `neon-ronin` | bladed kabuto with horn pair, spiked shoulder stacks, carbon underskin, neon edge lines | teal/magenta → lacquer black / crimson |
| **KESTREL** | derived — `ghostframe` frame + `volt-monk` surfacing | slim smooth shells, small dome head | digitigrade legs, thruster canards, arctic white / cobalt / cyan |
| **MANTIS** | derived — `neon-ronin` language | bladed segmented carapace, carbon underskin, neon grooves | mandible head, raptor forearm blades, digitigrade legs, acid green |

Each fighter keeps its existing `build.*` landmark (`mark`), its stats, its move
table and its animations. Only the forms and the surfacing change.

---

## 4. Acceptance

A change is done when, on captures taken from the **actual game scenes** (not a
model viewer):

1. every fighter's limbs taper and read as curved shells at full-body framing;
2. the dark underskin is visible at neck, waist, elbows and knees;
3. joint bezels are visible and stand proud at shoulder, elbow, hip, knee, ankle;
4. hands show separated fingers and feet show separated toe plates;
5. heads are ≤1/6 of body height and smooth;
6. large plates show a clean clearcoat highlight and no all-over hatch;
7. emissive reads as thin lines plus one hero element per fighter;
8. the two fighters on screen are still distinguishable as silhouettes at 40px;
9. the frame budget and the existing gates still pass.

---

## 5. Where this stopped, and what is still open

Eight rounds. The cast is built to §3 and the acceptance list in §4 is largely met;
what follows is the honest remainder, so the next person does not have to
re-derive it from the frames.

### Closed, and confirmed on a frame from the actual game

| fighter | reads as its sheet | evidence |
|---|---|---|
| VULKAN | yes | riveted slot-visor helm, amber slit, brass rib-vent disc |
| ANVIL | yes | spherical shoulder bosses with wheel hubs, goggled dome, safety yellow |
| RONIN-07 | yes | bladed kabuto with horns, three-blade shoulder stacks, lacquer black |
| BASTION | yes | pointed V heraldic breastplate over navy, big rounded pauldrons |
| SERAPH | yes | porcelain and violet, halo ring, dorsal blade fins |
| MANTIS | yes | acid green, bladed carapace |
| AXIOM | close | bare smooth ovoid on a ribbed neck; hero chest disc still weak |
| KESTREL | close | arctic shells, dome head, feet attached and segmented |
| NYX | close | glossy black, bronze-gold bezels, no green |
| VOLTA | close | copper-orange, domed pauldron caps, no wheel hub |

Cast-wide: limbs taper and read as curved shells, joint bezels are turned
hardware rather than coins, the dark underskin is visible at neck, waist, elbow
and knee, hands show separated fingers, feet are segmented and joined, heads are
at reference scale, and the paint carries a clearcoat with no all-over hatch.

### Still open

1. **AXIOM has no hero element.** `volt-monk`'s defining feature is a bright
   ringed arc-reactor disc dead centre of the chest. AXIOM's sternum carries a
   small dull oval that does not read at fight distance.
2. **VOLTA is copper-ORANGE rather than a dark burnished copper.** Its value was
   deliberately held to keep `aegis-01`'s mid-value primary place; if it should
   be a more muted metal, the value is the number to move, not the hue.
3. **NYX's gold is warmer than `vesper`'s.** A full R/G/B cube search found no
   hex at saturation >= 0.48 whose cyan-rim reflection clears hue 158 while
   staying in the gold band — under this arena's rim, "gold" and "never green"
   cannot both be fully had. The balance struck favours never-green.
4. **The heavy family still crowds at 40px.** BASTION, VOLTA and ANVIL share a
   spherical shoulder boss, a ribbed waist and a chunky boot; hue does most of
   the separating. KESTREL and AXIOM have the same problem in the light family.
5. **Flat slab plates survive in places** at close framing — SERAPH's back stack
   and some shoulder plates are still hard-cornered quads against §1.1.
6. **A few small colour escapes**: a green patch on VOLTA's knee cap (a bezel or
   greeble catching the rim, ~a few dozen pixels), and green stencil asterisks
   that are `STORY_INK.light` — a near-neutral shared by all ten fighters, so
   changing it is a cast-wide move rather than a per-character fix.
7. **ANVIL's trim measures rim-reflected hue 163**, the only other entry near the
   green failure. It was left alone deliberately: its shell is a 0.91-value
   hi-vis yellow, so the bezels have nothing to contrast against and no green
   reads on them in any frame.

### How to check any of this

`node tools/scenecap.mjs --width 1280 --height 720 --out shots/<name>` drives all
five pairs into a real fight and photographs every fighter in the actual arena.
It warns on stderr when a framing did not converge; a frame it warned about is
not evidence. See also `docs/SIMTEST.md` for the numeric layer, which is four
seconds and no browser.
