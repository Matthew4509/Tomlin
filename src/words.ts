// Plain words for a generated password (4 words) or passphrase (5): short, common, easy to type and to say aloud.
// Over 1,600 of them, so 4 picked at random are about 42 bits (each guess from a copied file then costs a full scrypt).
export const WORDS: readonly string[] = `
able acid acorn actor adult advice aerial affair afraid agent agree ahead aim air airport aisle alarm album alert
alien alley almond alpha amber anchor angle animal ankle answer apple april apron arch arena argue arm armor arrow
art artist ash aspen atlas atom attic audio august aunt autumn avenue award axis baby bacon badge bag bagel baker
balcony ball bamboo banana band banjo bank barn barrel basil basket bath beach bead beam bean bear beard beaver bed
bee beef beetle bell belt bench berry bicycle bike bird biscuit bishop bison bit black blade blank blanket blaze
blend blind block bloom blossom blue blush board boat body boil bolt bone bonus book boot border bottle bottom
boulder bow bowl box boy brain branch brass brave bread breeze brick bride bridge brief bright broom brother brown
brush bubble bucket buddy budget buffalo bugle bulb bundle bunny burger bus bush butter button buyer cabin cable
cactus cafe cage cake calm camel camera camp canal candle candy cane canoe canvas canyon cap captain car caramel card
cargo carpet carrot cart castle cat cattle cave cedar cell cellar cement center cereal chain chair chalk channel
chapel chapter charm chart cheese chef cherry chess chest chicken chief child chimney chin chip choice chorus cider
cinema circle circus city clam clap class clay clean clerk click cliff climb clinic clock cloth cloud clover clown
club coach coal coast coat cobra cocoa coconut code coffee coin cold collar colony color comb comet comic coral cord
core corn corner cottage cotton couch cougar count country couple course cousin cover cow cowboy crab cradle craft
crane crater crayon cream credit creek crew cricket crisp crop cross crowd crown crumb crystal cube cup cupboard
curtain curve cushion cycle daisy dance dawn day deck deer degree delta denim desert desk detail dew diamond diary
diesel dinner dish diver dock doctor dog doll dolphin dome donkey door dot dove dragon drama drawer dream dress drift
drill drink drum duck dune dusk dust eagle earth easel east echo edge eel egg elbow elder elk elm ember empire engine
entry envelope equal era errand essay evening event exam exit expert fabric face fact factory fairy falcon fall
family fan farm fashion father fawn feast feather fence fern ferry festival fever field fig film finger fire fish
flag flame flash flask fleet flint float flock flood floor flour flower flute foam focus fog folk food foot forest
fork fort fossil fox frame freedom fridge friend frog frost fruit fudge fuel gadget galaxy gallery game garage garden
garlic gate gear gecko gem genie giant gift ginger giraffe glass globe glove glow glue goat gold golf goose gorilla
grain grape grass gravel gravy green grid grill grove guard guest guide guitar gulf gum gym habit hair hall hammer
hamster hand harbor harp hat hawk hay hazel head heart heat hedge helmet hen herb hero heron hill hinge hippo hobby
hockey holly home honey hood hook hope horn horse hose hotel hour house hub human humor hunter hut ice icon idea
igloo image inch index ink inlet insect iron island ivory ivy jacket jaguar jam jar jazz jeans jelly jewel job jockey
journal judge juice jungle kayak kernel kettle key kid kind king kiosk kit kite kitten kiwi knee knife knot koala
label lace ladder lady lake lamb lamp lane laptop larch lark laser latch lava lawn layer leader leaf lemon lens
lesson letter lettuce level library lid light lilac lily lime linen lion lizard llama lobby lobster lock locket lodge
log lotus lunch lynx machine magnet mail mango manor map maple marble march market mask meadow medal melody melon
member memory menu meteor metro midnight mile milk mill mineral minute mirror mist mitten model mole moment monkey
month moon moose morning moss moth motor mound mouse mouth movie mud muffin mule museum music mustard nail name
napkin nation nature navy neck needle nest net network news night noble noodle north nose note novel number nurse nut
oak oar oasis oat ocean octopus office olive omelet onion opera orange orbit orchard orchid organ otter outfit oval
oven owl owner oyster pace paddle page paint palace palm pan panda panel paper parade parcel park parrot party pasta
path patio peach peak peanut pear pearl pebble pedal pelican pen pencil penguin pepper piano picnic pie pier pig
pigeon pillow pilot pine pink pipe pirate pizza planet plant plate plaza plum pocket poem poet pole pond pony pool
poppy porch port potato pottery powder prairie prince print prism puddle pulse pump pumpkin puppy purple puzzle quail
quarry queen quest quiet quilt quiz rabbit raccoon race radar radio raft rail rain rainbow raisin ranch range raven
razor recipe record reef relay remote rhino ribbon rice ridge ring river road robe robin robot rock rocket roof room
rooster root rope rose route rover rowboat ruby rug ruler runner saddle safari sail salad salmon salt sand sandal
satin sauce saucer scale scarf school scooter scout screen script sea seal season seat seed shadow shark sheep shelf
shell shield ship shirt shoe shore shovel shrimp signal silk silver singer sink sister skate sketch ski skirt sky
sled sleeve slice slope snail snake snow soap soccer sock sofa soil song soup south space spark sparrow spice spider
spike spinach spoon spring spruce square squid stable stadium stage stair stamp star statue steam steel stem stick
stone stool storm story stove straw stream street string studio sugar suit summer sun sunset supper surf swan sweater
swing sword syrup table tablet tackle tail tailor talent tank tape target taxi tea teacher temple tennis tent thread
thunder ticket tide tiger timber toast toe tomato tongue tool tooth torch tower town toy track tractor trail train
tree tribe trophy truck trumpet trunk tulip tuna tunnel turkey turtle tutor twig umbrella uncle unicorn union valley
valve vapor vase velvet violin visit voice volcano wagon waiter wall walnut walrus wand water wave wax weasel web
wheat wheel whale whistle willow wind window wing winter wire wizard wolf woman wood wool word worker world yacht
yard yarn year yogurt zebra zero zipper zone acre agate algae alloy amigo angel anvil apex arbor aroma aster aura
avid bale basin batch bayou beacon bingo birch blimp bluff bongo bonsai boxer brook buggy bunker cabana cadet camper
capsule cashew catnip celery chant cheetah chili cinder citrus clamp cobalt cocoon condor cosmos coyote crest cumin
dahlia dairy decoy dingo disco dynamo easy elf emu fable fiddle finch fjord flannel flora fluff foil forge frisbee
fusion gala garnet gazebo geyser glacier glider goblet gopher granite gravity grotto gull gusto haven hiker hoop
husky iris jasmine jester jigsaw jolly juniper kale karma kelp kennel kimono lagoon lantern lasso latte legend lemur
lilypad limbo locust lumber lyric magma mammoth mantis marsh mascot meerkat mermaid mesa mocha mohair monsoon mortar
mosaic muesli nectar nickel nimbus nomad nugget nutmeg oboe ocelot opal oregano osprey pagoda paprika parka pastry
pecan pewter pixel plaid plume polka poncho prawn pretzel puffin quartz quince radish ravine relic rhubarb ripple
rodeo rumba safety saffron salsa sapphire sardine savanna scallop sequoia sherbet sierra sitar slogan sonnet sorbet
spindle sprout stork summit sundae swamp tahini talon tango tapir thimble thistle toffee topaz totem toucan trellis
trivia trolley truffle tundra turnip tuxedo twine vanilla venture verse viking vinyl violet vista waffle walker
warren wasabi wigwam yeti yodel zenith zinc zinnia apricot badger beetroot bramble cobbler falafel firefly flamingo
gingham hedgehog kangaroo lavender mandolin marigold mushroom nightjar pancake peacock pinecone primrose sandbox
seashell snowman starfish tadpole teapot thrush tortoise treetop acrobat banner beaker blender bobcat bonnet bouquet
bracelet buckle cabbage canary carousel cashmere cavern chestnut chipmunk clarinet compass cookie cosmic crocus
cupcake custard delight diploma doorbell emerald fairway feline ferret fiesta fireside flyer fountain freckle galleon
garland gazelle gnome goggles gondola gumdrop hammock harvest hatchet heather hornet iceberg inkwell jackal jamboree
jukebox kestrel limerick macaw magpie mallard marmot minnow narwhal nutshell oatmeal outpost paddock palette panther
parsnip pheasant pickle pinwheel plankton plover pudding quiver radiator rattle reindeer riddle roadster rosebud
sapling seagull sherpa skylark slipper snorkel sparkle spatula sprocket squirrel stallion steeple stingray sundial
tarragon teacup thermos thicket tinsel toaster topsoil trinket tugboat turban vinegar wallaby warbler weaver whisker
wildcat windmill wombat zeppelin abbey adobe almanac anthem arcade ballad bazaar beret biplane blizzard bridle
brioche buffet caboose calypso candor carafe carnival caravan cascade chalet chariot chowder citadel clipper cobble
comrade corsage crescent croquet dazzle dinghy domino doodle dumpling eclair elixir epoch fennel flagon gallop gambit
goulash gourd griddle harmony hamlet hearth hickory hostel jalopy javelin jubilee kebab keystone kiln lilt lullaby
marina marzipan medley meringue minstrel monarch mustang nebula nougat oracle outback paella parasol pavilion pennant
piccolo pollen portal pueblo ragtime rampart rapids regatta rickshaw saga satchel scepter schooner sentry sextant
shamrock shanty sleigh sombrero stanza strudel tabby taffy tapestry tavern terrace tiara timpani tinder trapeze
troupe turret ukulele valet veranda viaduct village vineyard voyage wharf wicket wreath zephyr basalt bellows bobbin
bonfire brigade cameo canopy cellist cherub cinnamon claret cornet cowbell cupola dewdrop doublet dowel egret
falconer fiord flagship fondue fresco gaucho geode glade gremlin hayloft herald hobbit ingot jetty kingdom knapsack
lapel larkspur ledger loom mallet maypole mitre moat mongoose moorland muslin nautilus parapet pilgrim pinafore
plinth pumice quarter rafter ranger reed rivet rotunda rudder sable scroll sentinel shingle signet skiff sorrel spire
sprig squire tassel thatch tiller topiary trowel tunic turbine vellum vestry wicker yeoman yurt anise baobab beryl
bluebell bullfrog cardigan caribou catkin chamois cowslip curlew damson daffodil dormouse dunlin eider foxglove
gannet grouse hawthorn hyacinth ibis jackdaw jay lapwing linnet mayfly merlin moorhen mulberry nettle nuthatch oriole
osier parakeet peony petunia pipit quokka rambler redwing rook shrew skua snowdrop starling stoat swallow swift teal
tern thrift titmouse vole wagtail wren yarrow yew`.split(/\s+/).filter(Boolean);
