'use strict';
// Correct only an existing remote articulated body. All pointers are resolved
// locally after the complete engine version check; no address crosses the wire.
self.createRagdollPoseBridge = function ({ ex, memory }) {
  let scratch = 0;
  const dot = (a, b) => a.reduce((sum, v, i) => sum + v * b[i], 0);
  const cross = (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
  function address(value, bytes) {
    const n = Number(value);
    return Number.isSafeInteger(n) && n > 0 && n + bytes <= memory.buffer.byteLength ? n : 0;
  }
  function rigid(value, translationLimit) {
    if (!Array.isArray(value) || value.length !== 12 || value.some(v => !Number.isFinite(v))) return false;
    const axes = [value.slice(0,3),value.slice(3,6),value.slice(6,9)];
    return axes.every(a => Math.abs(dot(a,a)-1) <= .025)
      && Math.abs(dot(axes[0],axes[1])) <= .025 && Math.abs(dot(axes[0],axes[2])) <= .025
      && Math.abs(dot(axes[1],axes[2])) <= .025 && dot(cross(axes[0],axes[1]),axes[2]) >= .975
      && value.slice(9).every(v => Math.abs(v) <= translationLimit);
  }
  function transform(matrix, value, position) {
    return [0,1,2].map(i => matrix[i]*value[0]+matrix[3+i]*value[1]+matrix[6+i]*value[2]+(position?matrix[9+i]:0));
  }
  function relative(parent, child) {
    return [0,1,2,3].flatMap(column => {
      const value = child.slice(column*3,column*3+3).map((v,i)=>v-(column===3?parent[9+i]:0));
      return [0,1,2].map(axis=>dot(parent.slice(axis*3,axis*3+3),value));
    });
  }
  function apply(replica, state, { now = 0, poseReady = true } = {}) {
    const ped = replica?.ped || replica?.handle, pose = state?.pose;
    if (!poseReady || !state?.actions?.ragdoll || state.attachment || !pose || !Array.isArray(pose.bones)
      || pose.bones.length !== 21 || !ped || !ex.mpExists?.(ped) || !ex.mpIsPed?.(ped) || !ex.mpIsRagdoll?.(ped)
      || !['mpGetEntityAddress','mpPoseRagdollBody','mpSyncRagdollSkeleton','mpPoseRagdollBounds','mpAlloc'].every(name=>typeof ex[name]==='function')) return false;
    const signature = JSON.stringify(pose);
    const previous = replica.ragdollPose;
    if (previous?.signature === signature && (now < previous.at || now - previous.at > 300)) return false;
    if (previous?.signature !== signature) replica.ragdollPose = { signature, at: now };
    const data = new DataView(memory.buffer);
    const ptr = (at, bytes) => address(at,8) ? address(data.getBigUint64(at,true),bytes) : 0;
    const matrix = at => address(at,64) ? [0,4,8,16,20,24,32,36,40,48,52,56].map(offset=>data.getFloat32(at+offset,true)) : null;
    const base = address(ex.mpGetEntityAddress(ped),5272), frag = base && ptr(base+5264,192);
    const cache = frag && ptr(frag+104,424), type = frag && ptr(frag+120,248);
    if (!cache || !type || ptr(cache+272,192)!==frag || data.getUint16(frag+24,true)===65535) return false;
    const lodIndex = data.getUint32(frag+184,true), lodGroup = ptr(type+240,40);
    const lod = lodIndex <= 2 && lodGroup && ptr(lodGroup+16+lodIndex*8,288);
    const bound = ptr(cache+264,176), ownBound = ptr(cache+368,176), archetype = ptr(frag+16,40);
    const collider = ptr(cache+416,880), body = ptr(cache+400,392), skeleton = ptr(cache+376,40);
    if (!lod || !bound || bound!==ownBound || !archetype || ptr(archetype+32,176)!==bound
      || bound===ptr(lod+232,176) || !collider || !body || !skeleton) return false;
    const count = data.getUint8(lod+286), capacity = data.getUint16(bound+160,true), active = data.getUint16(bound+162,true);
    const children = ptr(lod+208,count*8), current = ptr(bound+120,count*64);
    const groups = data.getUint8(lod+282), groupData = ptr(lod+200,groups*8);
    const componentCount = data.getUint16(collider+776,true), componentMap = ptr(collider+768,componentCount*4);
    const jointCount = data.getUint16(body+384,true), joints = address(body+16,jointCount*8);
    const groupBits = ptr(cache+352,16), bitWords = groupBits && ptr(groupBits,Math.ceil(groups/32)*4);
    const colliderOffsets = data.getBigUint64(collider+872,true);
    if (count!==21 || capacity<count || active<count || !children || !current || !groupData || groups<1 || groups>127
      || componentCount<count || componentCount>capacity || componentCount>active || componentCount>127 || !componentMap
      || !address(current,componentCount*64) || jointCount<1 || jointCount>32 || !joints || !bitWords
      || colliderOffsets && !address(colliderOffsets,componentCount*64+32)) return false;
    const root = matrix(frag+32);
    if (!rigid(root,16000)) return false;
    const byTag = new Map();
    for (const bone of pose.bones) {
      if (!Number.isInteger(bone.tag) || byTag.has(bone.tag) || !rigid(bone.matrix,16000)
        || Math.hypot(...bone.matrix.slice(9).map((v,i)=>v-root[9+i]))>4) return false;
      byTag.set(bone.tag,bone.matrix);
    }
    const writes = [];
    for (let i=0;i<count;i++) {
      const child = ptr(children+i*8,176);
      if (!child || data.getUint16(child+16,true)!==i) return false;
      const tag = data.getUint16(child+18,true), bone = byTag.get(tag), drawable = ptr(child+160,240);
      const local = drawable && matrix(drawable+176);
      if (!bone || !rigid(local,4)) return false;
      const world = [0,1,2,3].flatMap(column=>transform(bone,local.slice(column*3,column*3+3),column===3));
      const value = relative(root,world);
      if (!rigid(value,4)) return false;
      writes.push(value);
    }
    const excluded = new Set();
    for (let i=0;i<groups;i++) {
      const group = ptr(groupData+i*8,79);
      if (!group) return false;
      const component = data.getUint8(group+78);
      if (component>=componentCount || component>127) return false;
      const joint = data.getInt32(componentMap+component*4,true);
      if (joint<0 || joint>=jointCount || !ptr(joints+joint*8,64)) return false;
      excluded.add(component);
    }
    if (!scratch) scratch=address(ex.mpAlloc(128n),128);
    if (!address(scratch,128) || excluded.size>127) return false;
    // InitBound (11831) allocated this per-instance composite and both matrix
    // arrays. Its immutable child bounds, resource data and source files stay untouched.
    const prior = new Uint8Array(memory.buffer,current,count*64).slice();
    try {
      const view=new DataView(memory.buffer);
      writes.forEach((value,index)=>{
        const at=current+index*64;
        for(let column=0;column<4;column++) {
          for(let axis=0;axis<3;axis++)view.setFloat32(at+column*16+axis*4,value[column*3+axis],true);
          view.setFloat32(at+column*16+12,column===3?1:0,true);
        }
      });
      new Uint8Array(memory.buffer,scratch,excluded.size).set([...excluded]);
      // The exclusion list contains original group collider-component indices.
      // It prevents native velocity reconstruction from distant packet snapshots.
      ex.mpPoseRagdollBody(BigInt(frag),excluded.size,BigInt(scratch));
      ex.mpSyncRagdollSkeleton(BigInt(frag),0);
      ex.mpPoseRagdollBounds(BigInt(frag),1,0,1,0,0n);
      return true;
    } catch {
      if (address(current,prior.length))new Uint8Array(memory.buffer,current,prior.length).set(prior);
      return false;
    }
  }
  return { apply, reset(replica) { if(replica)delete replica.ragdollPose; } };
};
