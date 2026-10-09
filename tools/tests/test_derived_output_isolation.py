"""Small export fixtures prove game inputs stay immutable at the function boundary."""
from collections import Counter
from contextlib import ExitStack, redirect_stdout
import hashlib
import io
import json
import os
from pathlib import Path
import struct
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import export_world_collision as collision
import extract_road_network as roads
from readonly_game_outputs import UnsafeOutputError


class DerivedOutputIsolationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="derived-output-isolation-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.game = self.root / "player-game"
        self.data = self.game / "data"
        self.wasm = self.game / "b/build/game.wasm"
        self.wasm.parent.mkdir(parents=True)
        self.wasm.write_bytes(b"unchanged original engine")
        self.archive = self.data / "x64/levels/gta5/paths.rpf"
        self.archive.parent.mkdir(parents=True)
        self.archive.write_bytes(bytes(16) + b"fixture-resource")
        self.ipl = self.data / "common/data/levels/gta5/paths.ipl"
        self.ipl.parent.mkdir(parents=True)
        self.ipl.write_text("vnod\n0,0,2,0,0,0,1,0,0.5,0,0,0,0,0,0,0,0,0,0,0,0,0\n"
                            "10,0,3,0,0,0,2,0,1,42,1,0,0,0,0,0,0,0,0,0,0,0\n"
                            "end\nlink\n0,1,6,2,1,0\nend\n")
        self.xml = self.ipl.with_suffix(".xml")
        self.xml.write_text("<root><objects /></root>")
        self.runtime = self.root / "launcher-output"
        self.runtime.mkdir()
        self.before = self.inventory(self.game)

    def tearDown(self):
        self.assertEqual(self.inventory(self.game), self.before, "Original game inputs changed")

    @staticmethod
    def inventory(root):
        return {path.relative_to(root).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
                for path in root.rglob("*") if path.is_file()}

    def collision_args(self, output=None, evidence=None):
        return SimpleNamespace(data=self.data, wasm=self.wasm,
                               output=output or self.runtime / "collision.bin",
                               evidence_output=evidence, bounds=(-1, -1, -1, 2, 2, 2),
                               path_prefix="x64/levels/gta5/")

    def export_collision(self, args):
        reader = SimpleNamespace(bounds=lambda: (0, 0, 0, 1, 1, 0),
                                 triangles=lambda: iter([(((0, 0, 0), (1, 0, 0), (0, 1, 0)), 17)]),
                                 types=Counter({8: 1}), unsupported=Counter())
        audit = SimpleNamespace(body_evidence=lambda index, _:
                                dict(function_index=index, name="fixture", signature="()",
                                     body_bytes=1, decode_complete=True))
        entry = dict(name="fixture.ybn", offset=0, size=self.archive.stat().st_size, resource=True)
        with ExitStack() as stack:
            stack.enter_context(patch.object(collision, "WasmAudit", return_value=audit))
            stack.enter_context(patch.object(collision, "local_archive_key", return_value=b"fixture"))
            stack.enter_context(patch.object(collision, "Zstd", return_value=SimpleNamespace(decompress=lambda _: b"decoded")))
            stack.enter_context(patch.object(collision, "archive_entries", return_value=[entry]))
            stack.enter_context(patch.object(collision, "BoundReader", return_value=reader))
            stack.enter_context(redirect_stdout(io.StringIO()))
            return collision.export(args)

    def test_valid_collision_exports_only_server_files_and_preserves_old_temp_aliases(self):
        output = self.runtime / "collision.bin"
        fixed_temp = output.with_name(output.name + ".tmp")
        fixed_temp.symlink_to(self.archive)
        evidence = self.runtime / "evidence.json"
        metadata = self.export_collision(self.collision_args(output, evidence))
        self.assertEqual(metadata["triangle_count"], 1)
        self.assertEqual(output.read_bytes()[:8], collision.MAGIC)
        self.assertEqual(struct.unpack_from(">i", output.read_bytes(), 56)[0], 1)
        self.assertEqual(json.loads(evidence.read_text())["binary_bytes"], output.stat().st_size)
        self.assertTrue(fixed_temp.is_symlink())
        self.assertEqual(set(self.runtime.iterdir()), {output, output.with_suffix(".meta.json"), evidence, fixed_temp})

    def test_collision_rejects_game_and_engine_destinations_before_reading_engine(self):
        for destination in (self.data / "generated.bin", self.game / "generated.bin", self.wasm,
                            collision.ROOT / "gta5data" / "generated.bin"):
            with self.subTest(destination=destination), patch.object(collision, "WasmAudit") as audit:
                with self.assertRaises(UnsafeOutputError):
                    collision.export(self.collision_args(destination))
                audit.assert_not_called()

    def test_collision_validates_sidecars_and_evidence_before_publishing(self):
        for kind in ("metadata_symlink", "metadata_hardlink", "evidence_symlink", "evidence_input", "duplicate"):
            with self.subTest(kind=kind):
                output = self.runtime / (kind + ".bin")
                metadata = output.with_suffix(".meta.json")
                evidence = self.runtime / (kind + ".json")
                if kind == "metadata_symlink":
                    metadata.symlink_to(self.wasm)
                elif kind == "metadata_hardlink":
                    os.link(self.archive, metadata)
                elif kind == "evidence_symlink":
                    evidence.symlink_to(self.wasm)
                elif kind == "evidence_input":
                    evidence = self.archive
                else:
                    evidence = metadata
                with patch.object(collision, "WasmAudit") as audit, self.assertRaises(UnsafeOutputError):
                    collision.export(self.collision_args(output, evidence))
                audit.assert_not_called()
                self.assertFalse(output.exists())

    def test_collision_rejects_aliases_to_inputs_and_custom_game_parents(self):
        for kind in ("symlink", "hardlink", "parent_symlink", "data_symlink"):
            with self.subTest(kind=kind):
                output = self.runtime / (kind + ".bin")
                args = self.collision_args(output)
                if kind == "symlink":
                    output.symlink_to(self.wasm)
                elif kind == "hardlink":
                    os.link(self.archive, output)
                elif kind == "parent_symlink":
                    alias = self.runtime / "aliased-game"
                    alias.symlink_to(self.game, target_is_directory=True)
                    args.output = alias / "unsafe.bin"
                else:
                    alias = self.root / "custom-data-alias"
                    alias.symlink_to(self.data, target_is_directory=True)
                    args.data, args.output = alias, self.game / "unsafe.bin"
                with self.assertRaises(UnsafeOutputError):
                    collision.export(args)

    def test_valid_road_exports_preserve_old_temp_hardlink(self):
        output = self.runtime / "roads.bin"
        fixed_temp = output.with_suffix(output.suffix + ".tmp")
        os.link(self.ipl, fixed_temp)
        audit = roads.export(self.ipl, output, self.xml)
        self.assertEqual((audit["nodes"], audit["links"]), (2, 1))
        self.assertEqual(output.read_bytes()[:8], roads.MAGIC)
        self.assertTrue(output.with_suffix(".audit.json").is_file())
        self.assertTrue(fixed_temp.samefile(self.ipl))
        self.assertEqual(set(self.runtime.iterdir()), {output, output.with_suffix(".audit.json"), fixed_temp})

    def test_road_function_rejects_entire_game_root_and_input_aliases(self):
        for kind in ("data", "game", "bundled", "ipl", "xml", "symlink", "hardlink", "parent_symlink"):
            with self.subTest(kind=kind):
                output = self.runtime / (kind + ".bin")
                if kind == "data":
                    output = self.data / "roads.bin"
                elif kind == "game":
                    output = self.game / "roads.bin"
                elif kind == "bundled":
                    output = roads.ROOT / "gta5data" / "roads.bin"
                elif kind in ("ipl", "xml"):
                    output = getattr(self, kind)
                elif kind == "symlink":
                    output.symlink_to(self.ipl)
                elif kind == "hardlink":
                    os.link(self.xml, output)
                else:
                    alias = self.runtime / "road-game-alias"
                    alias.symlink_to(self.game, target_is_directory=True)
                    output = alias / "roads.bin"
                with patch.object(roads, "load_ipl") as load, self.assertRaises(UnsafeOutputError):
                    roads.export(self.ipl, output, self.xml)
                load.assert_not_called()

    def test_road_audit_aliases_fail_before_binary_publication(self):
        for kind in ("symlink", "hardlink", "same_input"):
            with self.subTest(kind=kind):
                output = self.runtime / ("audit_" + kind + ".bin")
                audit = output.with_suffix(".audit.json")
                ipl = self.ipl
                if kind == "symlink":
                    audit.symlink_to(self.xml)
                elif kind == "hardlink":
                    os.link(self.ipl, audit)
                elif kind == "same_input":
                    ipl = audit
                    ipl.write_bytes(self.ipl.read_bytes())
                with patch.object(roads, "load_ipl") as load, self.assertRaises(UnsafeOutputError):
                    roads.export(ipl, output, self.xml)
                load.assert_not_called()
                self.assertFalse(output.exists())


if __name__ == "__main__":
    unittest.main()
