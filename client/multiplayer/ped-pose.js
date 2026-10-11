'use strict';
// Read-only native geometry sampling, called only from the original script owner.
self.createPedPoseSampler = function ({ ex, memory }) {
  const tags = [11816, 58271, 63931, 14201, 51826, 36864, 52301, 57597, 24816, 24817,
    24818, 64729, 45509, 61163, 18905, 10706, 40269, 28252, 57005, 39317, 31086];
  let scratch = 0;
  function sample(ped, origin) {
    if (!ex.mpPedBoneCoords || !ex.mpGetPedBoneIndex || !ex.mpAlloc || !ped || !ex.mpExists(ped)
      || !Array.isArray(origin) || origin.length !== 3 || !origin.every(Number.isFinite)) return null;
    if (!scratch) scratch = Number(ex.mpAlloc(64n));
    if (!Number.isSafeInteger(scratch) || scratch <= 0 || scratch + 64 > memory.buffer.byteLength) return null;
    function point(tag, offset) {
      let data = new DataView(memory.buffer);
      for (let i = 0; i < 3; i++) data.setFloat32(scratch + 32 + i * 8, offset[i], true);
      ex.mpPedBoneCoords(BigInt(scratch), ped, tag, BigInt(scratch + 32));
      data = new DataView(memory.buffer);
      return [0, 8, 16].map(i => data.getFloat32(scratch + i, true));
    }
    const bones = [];
    for (const tag of tags) {
      if (ex.mpGetPedBoneIndex(ped, tag) < 0) return null;
      const center = point(tag, [0, 0, 0]);
      if (!center.every(Number.isFinite) || Math.hypot(...center.map((v, i) => v - origin[i])) > 4) return null;
      const axes = [[1, 0, 0], [0, 1, 0], [0, 0, 1]].map(axis => point(tag, axis).map((v, i) => v - center[i]));
      // Missing bones can return one common point; never turn that into a shape.
      if (axes.some(axis => !axis.every(Number.isFinite) || Math.abs(Math.hypot(...axis) - 1) > .03)
        || Math.abs(axes[0].reduce((sum, v, i) => sum + v * axes[1][i], 0)) > .03
        || Math.abs(axes[0].reduce((sum, v, i) => sum + v * axes[2][i], 0)) > .03
        || Math.abs(axes[1].reduce((sum, v, i) => sum + v * axes[2][i], 0)) > .03) return null;
      bones.push({ tag, matrix: [...axes.flat(), ...center].map(v => Math.round(v * 1e6) / 1e6) });
    }
    const pose = { bones, origin: [...origin] };
    if (ex.mpGetPedBounds && ex.mpGetEntityAddress && ex.mpIsPed?.(ped)) {
      const address = ex.mpGetEntityAddress(ped);
      if (address > 0n && address <= BigInt(memory.buffer.byteLength - 160)) {
        ex.mpGetPedBounds(address, BigInt(scratch));
        const data = new DataView(memory.buffer);
        const minimum = [0, 4, 8].map(offset => data.getFloat32(scratch + offset, true));
        const maximum = [16, 20, 24].map(offset => data.getFloat32(scratch + offset, true));
        if (minimum.every((v, i) => Number.isFinite(v) && Number.isFinite(maximum[i]) && v <= maximum[i]
          && Math.abs(v - origin[i]) <= 4 && Math.abs(maximum[i] - origin[i]) <= 4))
          pose.bounds = { minimum, maximum };
      }
    }
    if (ex.mpFireWaterLevel && ex.mpFireRiverLevel) {
      const data = new DataView(memory.buffer);
      // These internal water functions take Vector3 (four-byte stride), not
      // the eight-byte script vector used by GET_PED_BONE_COORDS above.
      origin.forEach((v, i) => data.setFloat32(scratch + 32 + i * 4, v, true));
      const point = BigInt(scratch + 32), output = BigInt(scratch + 48);
      const found = ex.mpFireWaterLevel(point, output, 6, 20, 0n, 0)
        || ex.mpFireRiverLevel(point, output, 0);
      const height = found ? new DataView(memory.buffer).getFloat32(scratch + 48, true) : null;
      if (height === null || Number.isFinite(height) && Math.abs(height) <= 16000) pose.water_height = height;
    }
    return pose;
  }
  return { sample };
};
