from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from generate_material_catalog import SOURCE, OUTPUT, generate, joaat, parse_materials


class MaterialCatalogTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.materials = parse_materials(SOURCE.read_bytes())
        cls.by_name = {item["name"]: item for item in cls.materials}

    def test_catalog_matches_current_resource_and_contiguous_native_indices(self):
        self.assertEqual(213, len(self.materials))
        self.assertEqual(list(range(213)), [item["index"] for item in self.materials])
        self.assertEqual(generate(), OUTPUT.read_text())

    def test_concrete_hash_matches_known_native_material_identity(self):
        material = self.by_name["CONCRETE"]
        self.assertEqual(1, material["index"])
        self.assertEqual(1187676648, material["hash"])
        self.assertEqual(joaat("concrete_1"), material["hash"])
        self.assertEqual(joaat("concrete"), material["base_hash"])
        self.assertNotEqual(material["base_hash"], material["hash"])
        self.assertFalse(material["shoot_thru"])
        self.assertEqual(1., material["friction"])
        self.assertEqual(.3, material["elasticity"])

    def test_shoot_through_flag_is_distinct_from_visibility_and_penetration(self):
        glass = self.by_name["GLASS_SHOOT_THROUGH"]
        tarp = self.by_name["TARPAULIN"]
        self.assertEqual(112, glass["index"])
        self.assertTrue(glass["shoot_thru"])
        self.assertTrue(glass["see_thru"])
        self.assertTrue(tarp["shoot_thru"])
        self.assertFalse(tarp["see_thru"])
        self.assertEqual(1., tarp["penetration_resistance"])
        self.assertEqual(18, sum(item["shoot_thru"] for item in self.materials))

    def test_material_effect_label_does_not_replace_native_name_hash(self):
        item = self.by_name["PAVING_SLAB"]
        self.assertEqual("PAVING_SLABS", item["effect_material"])
        self.assertNotEqual(joaat(item["effect_material"]), item["base_hash"])

    def test_format_drift_is_rejected(self):
        for text in (b"13.00\n", b"12.00\nA B C\n"):
            with self.assertRaises(ValueError):
                parse_materials(text)


if __name__ == "__main__":
    unittest.main()
