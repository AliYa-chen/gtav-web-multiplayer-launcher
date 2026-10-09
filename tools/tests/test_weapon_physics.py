from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'tools'))
from generate_weapon_physics import OUTPUT, generate


class WeaponPhysicsTests(unittest.TestCase):
    def test_checked_in_catalog_matches_local_resource(self):
        self.assertEqual(OUTPUT.read_text(), generate())

    @unittest.skipUnless(shutil.which('javac') and shutil.which('java'), 'JDK required')
    def test_compiled_parameters_preserve_bounces_lifetime_and_absent_fields(self):
        source = '''import offline.multiplayer.WeaponPhysics;
public class PhysicsCheck {
  static void require(boolean value) { if (!value) throw new AssertionError(); }
  public static void main(String[] args) {
    require(WeaponPhysics.all().size() == 91);
    var grenade = WeaponPhysics.byHash(0x93E220BDL);
    require(grenade.speed() == 25 && grenade.gravity() == 1 && grenade.damping() == .05);
    require(grenade.lifetimeMs() == 4000 && grenade.ricochet() == 1 && grenade.pedRicochet() == 1);
    require(grenade.friction() == -1 && !grenade.explicitFields().contains("FrictionMultiplier"));
    var launcher = WeaponPhysics.byHash(0xA284510BL);
    require(launcher.friction() == .6 && launcher.impactDelayMs() == 1000 && launcher.lifetimeMs() == 30000);
    var sticky = WeaponPhysics.byHash(0x2C3731D9L);
    require(sticky.sticky() && sticky.lifetimeMs() == -1 && sticky.explicitFields().contains("LifeTime"));
    var rpg = WeaponPhysics.byHash(0xB1CA77B1L);
    require(rpg.destroyOnImpact() && rpg.speed() == 400 && rpg.gravity() == .02 && rpg.ricochet() == 0);
    var stun = WeaponPhysics.byHash(0x3656C8C1L);
    require(stun.nonLethal() && stun.damageTime() == 4 && stun.damageTimeInVehicle() == 5 && stun.penetration() == 0);
    require(WeaponPhysics.byHash((int)0xB1CA77B1) == rpg);
    require(WeaponPhysics.byHash(0) == null);
    try { WeaponPhysics.all().clear(); throw new AssertionError(); } catch (UnsupportedOperationException expected) {}
  }
}
'''
        with tempfile.TemporaryDirectory() as temp:
            fixture = Path(temp) / 'PhysicsCheck.java'
            fixture.write_text(source)
            subprocess.run(['javac', '--release', '17', '-d', temp, str(OUTPUT), str(fixture)], check=True, capture_output=True)
            result = subprocess.run(['java', '-cp', temp, 'PhysicsCheck'], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == '__main__':
    unittest.main()
