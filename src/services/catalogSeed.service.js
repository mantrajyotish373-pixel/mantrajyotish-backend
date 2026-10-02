const StoreProduct = require("../models/storeProduct.model");
const PlanetInsight = require("../models/planetInsight.model");

const STORE_DEFAULTS = [
    { title: "5 Mukhi Rudraksha Mala", category: "Mala & Beads", price: 999, oldPrice: 1499, rating: 4.9, popular: true, image: "https://images.unsplash.com/photo-1611080626919-7cf5a9dbab5b?auto=format&fit=crop&w=600&q=80" },
    { title: "Yellow Sapphire (Pukhraj)", category: "Gemstones", price: 3499, oldPrice: 4999, rating: 4.8, popular: true, image: "https://images.unsplash.com/photo-1615655406736-b37c4fabf923?auto=format&fit=crop&w=600&q=80" },
    { title: "Shree Yantra (Brass 3D)", category: "Yantras", price: 1299, oldPrice: 1899, rating: 4.7, image: "https://images.unsplash.com/photo-1606293926075-69a00dbfde81?auto=format&fit=crop&w=600&q=80" },
    { title: "Sphatik Crystal Mala", category: "Mala & Beads", price: 799, oldPrice: 1199, rating: 4.9, image: "https://images.unsplash.com/photo-1599643478518-a784e5dc4c8f?auto=format&fit=crop&w=600&q=80" },
    { title: "Red Coral (Moonga)", category: "Gemstones", price: 2499, oldPrice: 3299, rating: 4.8, image: "https://images.unsplash.com/photo-1535632066927-ab7c9ab60908?auto=format&fit=crop&w=600&q=80" },
    { title: "Kuber Yantra Brass Plate", category: "Yantras", price: 899, oldPrice: 1299, rating: 4.9, popular: true, image: "https://images.unsplash.com/photo-1606293926075-69a00dbfde81?auto=format&fit=crop&w=600&q=80" }
];

// Images are left empty on purpose: the app falls back to the picture bundled for each `key`.
const PLANET_DEFAULTS = [
    { key: "sun", title: "☀️ Sun (Surya)", description: "Represents power, confidence, leadership and success.", bgColor: "bg-orange-200", details: "In Vedic astrology, the Sun represents the soul, king, father, ego, honor, authority, and power. A strong Sun in your chart gives charisma and leadership. To strengthen the Sun, offer water to the rising Sun and chant the Aditya Hridayam." },
    { key: "moon", title: "🌙 Moon (Chandra)", description: "Represents emotions, peace, mind and creativity.", bgColor: "bg-sky-200", details: "The Moon represents the mind, emotions, mother, peace, and intuition. It governs mood swings and mental well-being. To strengthen the Moon, worship Lord Shiva on Mondays and keep a calm routine." },
    { key: "mars", title: "♂️ Mars (Mangal)", description: "Represents courage, energy and determination.", bgColor: "bg-red-200", details: "Mars is the planet of action, passion, anger, physical strength, and determination. It rules over courage, brothers, and land. To balance Mars energy, pray to Lord Hanuman, donate red lentils, and practice mindfulness." },
    { key: "mercury", title: "☿ Mercury (Budh)", description: "Represents intelligence, communication and business.", bgColor: "bg-green-200", details: "Mercury represents intellect, communication, humor, analytical skills, and business trade. A strong Mercury makes one witty and successful in business. Chant Budh mantras and donate green moong on Wednesdays." },
    { key: "jupiter", title: "♃ Jupiter (Guru)", description: "Represents wisdom, knowledge and prosperity.", bgColor: "bg-yellow-200", details: "Jupiter is the most benevolent planet, representing wisdom, education, luck, wealth, children, and spirituality. To strengthen Jupiter, worship Lord Vishnu, wear yellow on Thursdays, and respect your teachers." },
    { key: "venus", title: "♀ Venus (Shukra)", description: "Represents love, luxury and relationships.", bgColor: "bg-pink-200", details: "Venus governs love, marriage, beauty, arts, vehicles, and luxury. It represents the life partner in a male chart and rules over creativity. Worship Goddess Lakshmi on Fridays and keep your surroundings clean." },
    { key: "saturn", title: "♄ Saturn (Shani)", description: "Represents karma, discipline and hard work.", bgColor: "bg-gray-300", details: "Saturn is the planet of justice, discipline, delay, and life lessons. It rewards hard work and punishes unethical deeds. Remedies include donating mustard oil, helping the needy, and lighting a diya under a Peepal tree on Saturdays." },
    { key: "rahu", title: "☊ Rahu", description: "Represents ambition, illusion and transformation.", bgColor: "bg-purple-200", details: "Rahu is a shadow planet representing sudden changes, desire, materialism, tech, and illusions. A well-placed Rahu brings sudden wealth and fame. To pacify Rahu, chant Rahu mantras and feed birds." },
    { key: "ketu", title: "☋ Ketu", description: "Represents spirituality, detachment and liberation.", bgColor: "bg-cyan-200", details: "Ketu is the tail of the dragon, representing detachment, spirituality, occult knowledge, and liberation (Moksha). It brings deep inner wisdom. Worship Lord Ganesha and meditate regularly." }
];

// Fills an empty collection once, so the app looks the same until an admin edits something.
const seedIfEmpty = async (Model, defaults) => {
    if (await Model.estimatedDocumentCount() > 0) return;
    if (await Model.exists({})) return;
    try {
        await Model.insertMany(defaults.map((d, i) => ({ ...d, sortOrder: i })));
    } catch (e) { console.error("catalog seed failed:", e.message); }
};

const ensureStoreSeed = () => seedIfEmpty(StoreProduct, STORE_DEFAULTS);
const ensurePlanetSeed = () => seedIfEmpty(PlanetInsight, PLANET_DEFAULTS);

module.exports = { ensureStoreSeed, ensurePlanetSeed };
