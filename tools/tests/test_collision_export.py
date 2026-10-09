"""Geometry safety/transform checks independent of proprietary game assets."""
from pathlib import Path
import struct
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from export_world_collision import BoundReader, IDENTITY, compose, intersects, transform


def geometry():
    data = bytearray(1024)
    data[16] = 8
    struct.pack_into("<3f", data, 32, 20, 30, 40)
    struct.pack_into("<3f", data, 48, -20, -30, -40)
    struct.pack_into("<Q", data, 136, 0x50000200)
    struct.pack_into("<3f", data, 144, .5, 1., 2.)
    struct.pack_into("<3f", data, 160, 10., 20., 30.)
    struct.pack_into("<Q", data, 176, 0x50000240)
    struct.pack_into("<II", data, 208, 3, 1)
    struct.pack_into("<Q", data, 240, 0x50000280)
    struct.pack_into("<Q", data, 280, 0x50000290)
    data[288] = 1
    struct.pack_into("<I3H", data, 512, 0, 0, 1, 2)
    struct.pack_into("<9h", data, 576, 0, 0, 0, 2, 0, 0, 0, 3, 0)
    # Material flags deliberately nonzero; native material index remains 17.
    struct.pack_into("<Q", data, 640, 0x1000011)
    return data


class CollisionExportTests(unittest.TestCase):
    def test_quantized_vertices_use_per_axis_scale_and_geometry_center(self):
        triangles = list(BoundReader(geometry()).triangles())
        self.assertEqual(triangles, [(((10., 20., 30.), (11., 20., 30.), (10., 23., 30.)), 17)])

    def test_composite_transform_rotation_then_translation(self):
        # 90 degrees about Z, translated in world X.
        matrix = (0., 1., 0., 0., -1., 0., 0., 0., 0., 0., 1., 0., 100., 0., 0., 0.)
        triangle, _ = next(BoundReader(geometry()).triangles(matrix=matrix))
        self.assertEqual(triangle[0], (80., 10., 30.))
        self.assertEqual(triangle[1], (80., 11., 30.))
        self.assertEqual(triangle[2], (77., 10., 30.))

    def test_nested_matrix_composition_order(self):
        parent = list(IDENTITY)
        parent[12:15] = [10., 20., 30.]
        child = list(IDENTITY)
        child[12:15] = [2., 3., 4.]
        self.assertEqual(transform(compose(parent, child), (1., 1., 1.)), (13., 24., 35.))

    def test_invalid_vertex_reference_is_rejected(self):
        data = geometry()
        struct.pack_into("<H", data, 516, 50)
        with self.assertRaisesRegex(ValueError, "vertex exceeds"):
            list(BoundReader(data).triangles())

    def test_invalid_material_reference_is_rejected(self):
        data = geometry()
        data[656] = 1
        with self.assertRaisesRegex(ValueError, "material exceeds"):
            list(BoundReader(data).triangles())

    def test_out_of_resource_pointer_is_rejected(self):
        data = geometry()
        struct.pack_into("<Q", data, 176, 0x50009000)
        with self.assertRaisesRegex(ValueError, "pointer exceeds"):
            list(BoundReader(data).triangles())

    def test_unknown_primitive_is_counted_and_not_fabricated(self):
        data = geometry()
        data[512] = 3
        reader = BoundReader(data)
        self.assertEqual(list(reader.triangles()), [])
        self.assertEqual(reader.unsupported, {"polygon_type_3": 1})

    def test_invalid_quantization_is_rejected(self):
        data = geometry()
        struct.pack_into("<f", data, 144, float("nan"))
        with self.assertRaisesRegex(ValueError, "quantization"):
            list(BoundReader(data).triangles())

    def test_bounds_intersection_includes_crossing_triangles(self):
        self.assertTrue(intersects((-2., -2., 0., 2., 2., 0.), (-1., -1., -1., 1., 1., 1.)))
        self.assertFalse(intersects((2., 2., 2., 3., 3., 3.), (-1., -1., -1., 1., 1., 1.)))

    def test_composite_cycle_cannot_hang(self):
        data = geometry()
        data[16] = 10
        struct.pack_into("<Q", data, 112, 0x50000200)
        struct.pack_into("<Q", data, 120, 0x50000240)
        struct.pack_into("<HH", data, 160, 1, 1)
        struct.pack_into("<Q", data, 512, 0x50000000)
        struct.pack_into("<16f", data, 576, *IDENTITY)
        with self.assertRaisesRegex(ValueError, "cycle"):
            list(BoundReader(data).triangles())


if __name__ == "__main__":
    unittest.main()
