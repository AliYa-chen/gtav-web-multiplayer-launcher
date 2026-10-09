"""Exercise output attacks entirely in temporary fake game directories."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace
import zipfile

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools"))
import readonly_game_outputs as outputs
import build_multiplayer_client
import build_native_probe
import build_launcher_zip
import build_multiplayer_server
import build_server_bundle
import generate_launcher_engine_spec
import generate_material_catalog
import generate_weapon_catalog
import generate_weapon_physics


class ReadOnlyGameOutputsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="readonly-game-outputs-")
        self.base = Path(self.temp.name).resolve()
        self.game = self.base / "game"
        self.source = self.game / "b/8b0b5899ed/game.wasm"
        self.source.parent.mkdir(parents=True)
        self.source.write_bytes(b"original engine")
        self.package = self.game / "data/resources.rpf"
        self.package.parent.mkdir()
        self.package.write_bytes(b"original resource package")
        self.cache = self.base / "cache"
        self.cache.mkdir()
        self.before = self.snapshot()
        self.guard = patch.object(outputs, "GAME_ROOT", self.game)
        self.guard.start()

    def tearDown(self):
        try:
            self.assertEqual(self.snapshot(), self.before, "game inputs must remain byte-for-byte unchanged")
        finally:
            self.guard.stop()
            self.temp.cleanup()

    def snapshot(self):
        return {p.relative_to(self.game).as_posix():
                hashlib.sha256(p.read_bytes()).hexdigest() if p.is_file() else "directory"
                for p in self.game.rglob("*")}

    def test_rejects_default_and_selected_game_roots_before_creating_directories(self):
        for destination in (self.package, self.game / "new/folder/output.bin"):
            with self.subTest(destination=destination), self.assertRaises(outputs.UnsafeOutputError):
                outputs.atomic_write_bytes(destination, b"changed")
        selected = self.base / "selected-game"
        selected.mkdir()
        with self.assertRaises(outputs.UnsafeOutputError):
            outputs.atomic_write_bytes(selected / "missing/output.bin", b"changed", protected_roots=(selected,))
        self.assertEqual(list(selected.iterdir()), [])

    def test_rejects_source_outside_game_directory(self):
        source = self.base / "input.bin"
        source.write_bytes(b"input")
        with self.assertRaises(outputs.UnsafeOutputError):
            outputs.atomic_write_bytes(source, b"changed", sources=(source,))
        self.assertEqual(source.read_bytes(), b"input")

    def test_case_alias_cannot_escape_protected_game_root(self):
        alternate = self.game.with_name(self.game.name.upper())
        if not alternate.exists():
            self.skipTest("filesystem distinguishes case")
        with self.assertRaises(outputs.UnsafeOutputError):
            outputs.atomic_write_bytes(alternate / "new/output.bin", b"changed")

    def test_rejects_output_and_parent_symlinks_including_broken_outputs(self):
        linked = self.cache / "linked.bin"
        linked.symlink_to(self.package)
        broken = self.cache / "broken.bin"
        broken.symlink_to(self.base / "does-not-exist")
        parent = self.cache / "game-link"
        parent.symlink_to(self.game, target_is_directory=True)
        for destination in (linked, broken, parent / "data/new/output.bin"):
            with self.subTest(destination=destination), self.assertRaises(outputs.UnsafeOutputError):
                outputs.atomic_write_bytes(destination, b"changed")

    def test_rejects_hard_link_to_explicit_input(self):
        target = self.cache / "input-alias.bin"
        os.link(self.source, target)
        with self.assertRaises(outputs.UnsafeOutputError):
            outputs.atomic_write_bytes(target, b"changed", sources=(self.source,))

    def test_atomic_publish_does_not_modify_other_hard_links_or_old_temp_symlinks(self):
        target = self.cache / "derived.bin"
        os.link(self.package, target)
        old_temporary = target.with_name(target.name + ".tmp")
        old_temporary.symlink_to(self.package)
        outputs.atomic_write_bytes(target, b"derived output")
        self.assertEqual(target.read_bytes(), b"derived output")
        self.assertTrue(old_temporary.is_symlink())
        self.assertFalse(os.path.samefile(target, self.package))
        self.assertEqual(sorted(p.name for p in self.cache.iterdir()), ["derived.bin", "derived.bin.tmp"])

    def test_preflights_all_sidecars_and_rejects_duplicate_destinations(self):
        target = self.cache / "derived.bin"
        report = target.with_suffix(".json")
        report.symlink_to(self.package)
        with self.assertRaises(outputs.UnsafeOutputError):
            outputs.validate_outputs((target, report))
        self.assertFalse(target.exists())
        with self.assertRaises(outputs.UnsafeOutputError):
            outputs.validate_outputs((target, target))

    def test_failed_publish_preserves_old_output_and_removes_unique_temporary(self):
        target = self.cache / "derived.bin"
        target.write_bytes(b"previous output")
        with patch.object(outputs.os, "replace", side_effect=OSError("publish failure")):
            with self.assertRaisesRegex(OSError, "publish failure"):
                outputs.atomic_write_bytes(target, b"new output")
        self.assertEqual(target.read_bytes(), b"previous output")
        self.assertEqual(list(self.cache.iterdir()), [target])

    def test_catalog_entrypoints_reject_output_symlinks_before_generating(self):
        target = self.cache / "catalog.java"
        target.symlink_to(self.package)
        for generator in (generate_weapon_catalog, generate_material_catalog, generate_weapon_physics):
            with self.subTest(generator=generator.__name__), \
                    patch.object(generator, "OUTPUT", target), \
                    patch.object(generator, "SOURCE", self.source), \
                    patch.object(generator, "generate") as generate, \
                    patch.object(sys, "argv", [generator.__name__]):
                with self.assertRaises(outputs.UnsafeOutputError):
                    generator.main()
                generate.assert_not_called()

    def test_probe_preflights_sidecar_and_protects_entire_selected_game_root(self):
        report = self.cache / "probe.json"
        report.symlink_to(self.package)
        for target in (self.cache / "probe.wasm", self.game / "data/new.wasm"):
            with self.subTest(target=target), patch.object(build_native_probe, "checked_audit") as audit:
                with self.assertRaises(SystemExit):
                    build_native_probe.main(["--wasm", str(self.source), "--output", str(target)])
                audit.assert_not_called()

    def test_engine_spec_rejects_selected_game_path_and_symlink_before_generating(self):
        linked = self.cache / "engine-spec.json"
        linked.symlink_to(self.package)
        for target in (linked, self.game / "data/spec.json"):
            with self.subTest(target=target), patch.object(generate_launcher_engine_spec, "generate") as generate:
                with self.assertRaises(SystemExit):
                    generate_launcher_engine_spec.main(["--wasm", str(self.source), "--output", str(target)])
                generate.assert_not_called()

    def test_standalone_builders_protect_external_game_root_from_engine_layout(self):
        selected = self.base / "other-player-game"
        source = selected / "b/other-build/game.wasm"
        source.parent.mkdir(parents=True)
        source.write_bytes(b"external original")
        target = selected / "data/output"
        with patch.object(build_native_probe, "checked_audit") as audit:
            with self.assertRaises(SystemExit):
                build_native_probe.main(["--wasm", str(source), "--output", str(target.with_suffix(".wasm"))])
            audit.assert_not_called()
        with patch.object(generate_launcher_engine_spec, "generate") as generate:
            with self.assertRaises(SystemExit):
                generate_launcher_engine_spec.main(["--wasm", str(source), "--output", str(target.with_suffix(".json"))])
            generate.assert_not_called()
        self.assertEqual(source.read_bytes(), b"external original")
        self.assertFalse(target.parent.exists())

    def test_linked_engine_does_not_remove_selected_root_protection(self):
        selected = self.base / "other-player-game"
        source = selected / "b/other-build/game.wasm"
        source.parent.mkdir(parents=True)
        source.symlink_to(self.source)
        target = selected / "data/output"
        with patch.object(build_native_probe, "checked_audit") as audit:
            with self.assertRaises(SystemExit):
                build_native_probe.main(["--wasm", str(source), "--output", str(target.with_suffix(".wasm"))])
            audit.assert_not_called()
        with patch.object(generate_launcher_engine_spec, "generate") as generate:
            with self.assertRaises(SystemExit):
                generate_launcher_engine_spec.main(["--wasm", str(source), "--output", str(target.with_suffix(".json"))])
            generate.assert_not_called()
        self.assertFalse(target.parent.exists())

    def test_builder_preflights_reports_and_rejects_ancestor_runtime_before_subprocess(self):
        # Use the actual supported layout with a fake engine hash; no real engine is read.
        with patch.object(build_multiplayer_client, "ORIGINAL_WASM_SHA256", hashlib.sha256(self.source.read_bytes()).hexdigest()):
            with patch.object(build_multiplayer_client.subprocess, "run") as run:
                for runtime in (self.base, self.game / "runtime"):
                    with self.subTest(runtime=runtime), self.assertRaises(SystemExit):
                        build_multiplayer_client.main(["--game-dir", str(self.game), "--runtime-dir", str(runtime)])
                directory = self.cache / "online"
                directory.mkdir()
                (directory / "game.json").symlink_to(self.package)
                with self.assertRaises(SystemExit):
                    build_multiplayer_client.main(["--game-dir", str(self.game), "--runtime-dir", str(self.cache)])
                run.assert_not_called()

    def test_launcher_package_includes_guard_and_ignores_preexisting_temp_alias(self):
        target = self.cache / "launcher.zip"
        os.link(self.package, target)
        legacy_temp = target.with_suffix(".zip.tmp")
        legacy_temp.symlink_to(self.package)
        report = build_launcher_zip.build_launcher(target, root=ROOT)
        self.assertFalse(report["game_resources_included"])
        with zipfile.ZipFile(target) as archive:
            self.assertIn("tools/readonly_game_outputs.py", archive.namelist())
            self.assertIsNone(archive.testzip())
        self.assertTrue(legacy_temp.is_symlink())

    def test_launcher_package_rejects_final_and_parent_aliases_to_game(self):
        target = self.cache / "unsafe.zip"
        target.symlink_to(self.package)
        parent = self.cache / "game-link"
        parent.symlink_to(self.game, target_is_directory=True)
        for destination in (target, parent / "data/new/unsafe.zip"):
            with self.subTest(destination=destination), self.assertRaises(ValueError):
                build_launcher_zip.build_launcher(destination, root=ROOT)

    def server_project(self):
        project = self.base / "server-project"
        server = project / "server"
        source = server / "src/main/java/offline/multiplayer/Main.java"
        source.parent.mkdir(parents=True)
        source.write_text('private static final String VERSION = "0.0-test";')
        for name in ("multiplayer-server.jar", "README.md", "Start-Server.cmd",
                     "Start-Server.command", "Start-Server.sh"):
            (server / name).write_bytes(b"fixture server file")
        return project, server

    def test_server_compiler_rejects_unsafe_output_before_running_compiler(self):
        project, _ = self.server_project()
        target = self.cache / "server.jar"
        target.symlink_to(self.package)
        with patch.object(build_multiplayer_server, "ROOT", project), \
                patch.object(build_multiplayer_server.subprocess, "run") as run:
            for destination in (target, self.package):
                with self.subTest(destination=destination), self.assertRaises(SystemExit):
                    build_multiplayer_server.main(["--javac", "fixture-javac", "--output", str(destination)])
            run.assert_not_called()

    def test_server_compiler_publishes_without_following_fixed_temp_alias(self):
        project, _ = self.server_project()
        target = self.cache / "server.jar"
        fixed_temp = target.with_suffix(".jar.tmp")
        fixed_temp.symlink_to(self.package)
        def compile_fixture(command, **kwargs):
            classes = Path(command[command.index("-d") + 1])
            main = classes / "offline/multiplayer/Main.class"
            main.parent.mkdir(parents=True)
            main.write_bytes(b"fixture bytecode")
            return SimpleNamespace(returncode=0, stdout="", stderr="")
        with patch.object(build_multiplayer_server, "ROOT", project), \
                patch.object(build_multiplayer_server.subprocess, "run", side_effect=compile_fixture):
            build_multiplayer_server.main(["--javac", "fixture-javac", "--output", str(target)])
        with zipfile.ZipFile(target) as archive:
            self.assertEqual(archive.read("offline/multiplayer/Main.class"), b"fixture bytecode")
        self.assertTrue(fixed_temp.is_symlink())

    def test_server_bundle_preflights_metadata_before_running_java(self):
        project, server = self.server_project()
        (server / "VERSION.json").symlink_to(self.package)
        with patch.object(build_server_bundle, "ROOT", project), \
                patch.object(build_server_bundle.subprocess, "run") as run:
            with self.assertRaises(SystemExit):
                build_server_bundle.main(["--skip-build"])
            run.assert_not_called()
        self.assertFalse((project / "archive").exists())

    def test_server_bundle_does_not_follow_old_fixed_temp_alias(self):
        project, server = self.server_project()
        output = project / "archive/packages" / (
            "gta5-public-server-" + build_server_bundle.date.today().isoformat() + ".zip")
        output.parent.mkdir(parents=True)
        old_temp = output.with_suffix(".zip.tmp")
        old_temp.symlink_to(self.package)
        with patch.object(build_server_bundle, "ROOT", project), \
                patch.object(build_server_bundle.subprocess, "run", return_value=SimpleNamespace(
                    stdout="GTA V 沙盒公共战局服务 0.0-test", returncode=0)):
            build_server_bundle.main(["--skip-build"])
        with zipfile.ZipFile(output) as archive:
            self.assertIsNone(archive.testzip())
            self.assertIn("gta5-public-server/VERSION.json", archive.namelist())
        self.assertEqual(json.loads((server / "VERSION.json").read_text())["version"], "0.0-test")
        self.assertTrue(old_temp.is_symlink())


if __name__ == "__main__":
    unittest.main(verbosity=2)
