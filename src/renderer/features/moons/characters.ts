import type { MoonRole } from '@shared/moons'
import type * as THREE from 'three'
import { TAU, clamp, lerp, out } from './motion'
import type { MoonColor, MoonTheme } from './palette'
import { drawPlainMoon } from './plain'
import type { DrawMoon, MoonState } from './types'

/*
 * The four characters: little moons with real light, drawn with Three.js (MIT), ported from the approved prototype (design/pair-prototypes/chars.js).
 * Three.js is loaded only here, with a dynamic import, so it is in a chunk of its own that a chat without two moons never fetches.
 * All characters are rendered one at a time on one shared offscreen WebGL canvas and copied to the sky's own 2D canvas.
 * No WebAssembly and no eval are needed. If WebGL is missing, is lost or fails, the plain moons (plain.ts) are drawn instead, and `onLost` is told
 * once: a renderer the browser gives back after its graphics process went away draws nothing, so whoever keeps this makes a new one.
 */

export interface Characters {
  /** Draws one moon and everything around it (halo, pulses, sparks, the "!" and the z's). Never throws: it falls back to the plain moon. */
  draw(ctx: CanvasRenderingContext2D, o: DrawMoon): void
  /** A PNG data URL of the face, square, size x size pixels. An empty string if it cannot be made now. */
  snapshot(role: MoonRole, color: MoonColor, theme: MoonTheme, size: number): string
  /** Frees the geometries, materials, textures and the renderer. Drawing after this gives plain moons. */
  dispose(): void
}

/** The parts of Three.js that are used, so the module is imported by name and the bundler leaves out the rest. */
type Kit = Pick<
  typeof THREE,
  | 'WebGLRenderer' | 'Scene' | 'PerspectiveCamera' | 'Vector2' | 'Vector3' | 'Color' | 'ShaderMaterial' | 'MeshBasicMaterial' | 'Mesh' | 'Group' | 'CanvasTexture'
  | 'SphereGeometry' | 'TorusGeometry' | 'CylinderGeometry' | 'CircleGeometry' | 'BoxGeometry' | 'PlaneGeometry' | 'CapsuleGeometry' | 'LatheGeometry'
  | 'DoubleSide' | 'LinearSRGBColorSpace' | 'ColorManagement'
>

/** Loads Three.js and makes the characters, or gives null when a WebGL renderer cannot be made. `onLost`: these will draw no more. */
export async function createCharacters(onLost?: () => void): Promise<Characters | null> {
  let kit: Kit
  try {
    const {
      WebGLRenderer, Scene, PerspectiveCamera, Vector2, Vector3, Color, ShaderMaterial, MeshBasicMaterial, Mesh, Group, CanvasTexture,
      SphereGeometry, TorusGeometry, CylinderGeometry, CircleGeometry, BoxGeometry, PlaneGeometry, CapsuleGeometry, LatheGeometry,
      DoubleSide, LinearSRGBColorSpace, ColorManagement
    } = await import('three')
    kit = {
      WebGLRenderer, Scene, PerspectiveCamera, Vector2, Vector3, Color, ShaderMaterial, MeshBasicMaterial, Mesh, Group, CanvasTexture,
      SphereGeometry, TorusGeometry, CylinderGeometry, CircleGeometry, BoxGeometry, PlaneGeometry, CapsuleGeometry, LatheGeometry,
      DoubleSide, LinearSRGBColorSpace, ColorManagement
    }
  } catch (error) {
    console.warn('Three.js could not be loaded; the plain moons are used.', error)
    return null
  }
  try {
    return build(kit, onLost)
  } catch (error) {
    console.warn('The characters could not be made; the plain moons are used.', error)
    return null
  }
}

type Mat = THREE.ShaderMaterial | THREE.MeshBasicMaterial
type Uniforms = Record<string, THREE.IUniform>
/** Uniforms every body part of one character shares, so one change of color or light moves them all. */
type RigUniforms = {
  hi: { value: THREE.Color }
  mid: { value: THREE.Color }
  lo: { value: THREE.Color }
  night: { value: THREE.Color }
  L: { value: THREE.Vector3 }
  lit: { value: number }
  t: { value: number }
}

type ToolName = 'hammer' | 'block' | 'doc' | 'sheet' | 'flask' | 'orb'
const TOOL_NAMES: ToolName[] = ['hammer', 'block', 'doc', 'sheet', 'flask', 'orb']

interface Tool {
  o: THREE.Group
  /** 'r': held in the right hand and follows it; 'w': placed by the pose. */
  par: 'r' | 'w'
}
interface Eye {
  open: THREE.Group
  pu: THREE.Group
  arc: THREE.Mesh<THREE.TorusGeometry, THREE.MeshBasicMaterial>
}
interface Paper {
  draw(a?: number): void
}
interface Rig {
  g: THREE.Group
  bodyG: THREE.Group
  u: RigUniforms
  eyes: Eye[]
  mouth: THREE.Mesh
  hl: THREE.Mesh
  hr: THREE.Mesh
  tools: Record<ToolName, Tool>
  specs?: THREE.Group
  ring?: THREE.Group
  /** The block the builder hits: it is squashed when the hammer lands. */
  block: THREE.Mesh
  sheetPaper: Paper
  sheetPts: [number, number][]
  pencil: THREE.Group
  bubbles: THREE.Mesh[]
}

interface Pose {
  lx: number; ly: number; lz: number; rx: number; ry: number; rz: number
  yaw: number; tilt: number; lean: number; by: number; sq: number; px: number; py: number
  lid: number; sleep: number; happy: number; specs: number; mouth: number
}
const POSE_KEYS: (keyof Pose)[] = ['lx', 'ly', 'lz', 'rx', 'ry', 'rz', 'yaw', 'tilt', 'lean', 'by', 'sq', 'px', 'py', 'lid', 'sleep', 'happy', 'specs', 'mouth']

/** What the 2D canvas adds around the picture of the character. */
type Fx = { k: 'spark'; age: number; x: number; y: number } | { k: 'bang'; x: number; y: number } | { k: 'orb'; x: number; y: number } | null

interface Memory {
  P: Pose
  tool: Partial<Record<ToolName, number>>
  seen: number
}

const FONT = "'Outfit Variable', 'Segoe UI', system-ui, sans-serif"
/** The size of the offscreen canvas, and how far from the centre (in units of the moon) the picture reaches. */
const Q = 420
const EXT = 2.45
/** A pose that was not drawn for this long is forgotten (it eases from the start again next time). */
const FORGET_MS = 60_000

const NOISE = `float h(vec3 p){return fract(sin(dot(p,vec3(127.1,311.7,74.7)))*43758.5453);}
    float ns(vec3 p){vec3 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(mix(h(i),h(i+vec3(1,0,0)),f.x),mix(h(i+vec3(0,1,0)),h(i+vec3(1,1,0)),f.x),f.y),mix(mix(h(i+vec3(0,0,1)),h(i+vec3(1,0,1)),f.x),mix(h(i+vec3(0,1,1)),h(i+vec3(1,1,1)),f.x),f.y),f.z);}`
const VS = `uniform float lump;varying vec3 vN;varying vec3 vV;varying vec3 vP;${NOISE}
    void main(){vP=position;vec3 q=position+normal*(ns(position*2.3+7.)-.5)*lump;vec4 mv=modelViewMatrix*vec4(q,1.);vN=normalMatrix*normal;vV=-mv.xyz;gl_Position=projectionMatrix*mv;}`
const FS = `precision highp float;uniform vec3 hi;uniform vec3 mid;uniform vec3 lo;uniform vec3 night;uniform vec3 L;uniform float lit;uniform float kind;uniform float t;varying vec3 vN;varying vec3 vV;varying vec3 vP;${NOISE}
    float crater(vec3 p,vec3 c,float r){float a=acos(clamp(dot(p,normalize(c)),-1.,1.));return -smoothstep(r,r*.55,a)*.75+smoothstep(r*.28,0.,abs(a-r))*.5;}
    void main(){vec3 N=normalize(vN),V=normalize(vV),p=normalize(vP);float x=0.;
      if(kind==1.){float w=ns(p*2.4+vec3(t*.05,0.,0.));x=smoothstep(.1,.95,sin(p.y*8.5+w*2.4))*.5-.12;}
      if(kind==2.){x=(ns(p*3.2+vec3(0.,t*.04,0.))-.5)*.55+crater(p,vec3(-.7,.35,.5),.2)*.5+crater(p,vec3(.75,-.45,.45),.16)*.5;}
      if(kind==3.){x=(ns(p*2.1+vec3(t*.08))-.5)*.75;}
      if(kind==4.){x=crater(p,vec3(-.8,-.25,.5),.26)+crater(p,vec3(.82,.22,.4),.2)+crater(p,vec3(.3,-.85,.4),.22)+crater(p,vec3(-.35,-.8,.5),.13)+crater(p,vec3(-.6,.7,.1),.22);}
      float d=dot(N,L),s=smoothstep(-.1,.26,d);
      vec3 day=mix(lo,mid,smoothstep(-.1,.6,d));day=mix(day,hi,pow(max(d,0.),3.2)*.72);day*=1.+x*.38;
      vec3 c=mix(night*(1.+x*.3),day,s);
      float fr=pow(1.-max(dot(N,V),0.),2.4);
      c+=mid*fr*(.12+.5*s*lit);c+=hi*pow(max(dot(reflect(-L,N),V),0.),26.)*.35*s;
      gl_FragColor=vec4(c,1.);}`

const GOLD: [string, string, string] = ['#fff3cf', '#f6c85f', '#9a6a18']
const STEEL: [string, string, string] = ['#ffffff', '#b9c2dd', '#4c5678']
const WOOD: [string, string, string] = ['#ffe0c2', '#c98a5a', '#5f3520']
const CREAM: [string, string, string] = ['#ffffff', '#f2ecff', '#9a90c4']
const KIND: Record<MoonRole, number> = { builder: 1, reviewer: 2, planner: 3, tester: 4 }

function build(T: Kit, onLost?: () => void): Characters {
  const previousManagement = T.ColorManagement.enabled
  // The shaders and the flat colors take plain sRGB numbers, as the prototype did. This is put back in dispose, so other users of Three.js are not changed.
  T.ColorManagement.enabled = false
  let rn: THREE.WebGLRenderer
  try {
    rn = new T.WebGLRenderer({ alpha: true, antialias: true })
  } catch (error) {
    T.ColorManagement.enabled = previousManagement
    throw error
  }
  rn.outputColorSpace = T.LinearSRGBColorSpace
  rn.setPixelRatio(1)
  rn.setSize(Q, Q, false)
  rn.setClearColor(0x000000, 0)
  const canvas = rn.domElement
  const scene = new T.Scene()
  const cam = new T.PerspectiveCamera(24, 1, 0.1, 60)
  cam.position.z = EXT / Math.tan((12 * Math.PI) / 180)

  let lost = false
  let broken = false
  let disposed = false
  /** The context is gone for good as far as this renderer goes. Said once, later, so that nobody makes a new one in the middle of a frame. */
  const gone = () => {
    if (lost || disposed) return
    lost = true
    setTimeout(() => onLost?.(), 0)
  }
  canvas.addEventListener('webglcontextlost', gone)

  const V3 = (x: number, y: number, z: number) => new T.Vector3(x, y, z)
  const cl = (hex: string) => new T.Color(hex)
  const propL = { value: V3(0.42, 0.62, 0.66).normalize() }

  const mat = (u: Uniforms, kind = 0, lump = 0) => new T.ShaderMaterial({ vertexShader: VS, fragmentShader: FS, uniforms: { ...u, kind: { value: kind }, lump: { value: lump } } })
  const flat = (c: string, o = 1) => new T.MeshBasicMaterial({ color: cl(c), transparent: o < 1, opacity: o, depthWrite: o >= 1, side: T.DoubleSide })
  const prop = (hi: string, mid: string, lo: string, u?: { L: THREE.IUniform }) =>
    mat({ hi: { value: cl(hi) }, mid: { value: cl(mid) }, lo: { value: cl(lo) }, night: { value: cl(lo).multiplyScalar(0.45) }, L: u ? u.L : propL, lit: { value: 0.5 }, t: { value: 0 } })
  const M = <G extends THREE.BufferGeometry, Mt extends Mat>(geo: G, m: Mt) => new T.Mesh(geo, m)
  const sph = <Mt extends Mat>(r: number, m: Mt, s?: [number, number, number]) => {
    const x = M(new T.SphereGeometry(r, 40, 30), m)
    if (s) x.scale.set(s[0], s[1], s[2])
    return x
  }
  const tor = <Mt extends Mat>(r: number, w: number, m: Mt, arc?: number) => M(new T.TorusGeometry(r, w, 12, 48, arc || Math.PI * 2), m)
  const cyl = (a: number, b: number, hgt: number, m: Mat, n = 20) => M(new T.CylinderGeometry(a, b, hgt, n), m)
  const on = (o: THREE.Object3D, yaw: number, pitch: number, R: number) => {
    o.position.set(Math.sin(yaw) * Math.cos(pitch) * R, Math.sin(pitch) * R, Math.cos(yaw) * Math.cos(pitch) * R)
    o.rotation.set(-pitch, yaw, 0, 'YXZ')
    return o
  }
  const paper = (draw: (c: CanvasRenderingContext2D, a: number) => void): { tx: THREE.CanvasTexture; paper: Paper } => {
    const c = document.createElement('canvas')
    c.width = 200
    c.height = 150
    const tx = new T.CanvasTexture(c)
    const g = c.getContext('2d')
    return {
      tx,
      paper: {
        draw: (a = 0) => {
          if (!g) return
          draw(g, a)
          tx.needsUpdate = true
        }
      }
    }
  }

  const rigs = new Map<MoonRole, Rig>()

  function makeRig(role: MoonRole): Rig {
    const g = new T.Group()
    const face = new T.Group()
    const bodyG = new T.Group()
    const hat = new T.Group()
    const u: RigUniforms = { hi: { value: cl('#fff') }, mid: { value: cl('#fff') }, lo: { value: cl('#fff') }, night: { value: cl('#000') }, L: { value: V3(0, 0, 1) }, lit: { value: 1 }, t: { value: 0 } }
    const body = M(new T.SphereGeometry(1, 72, 54), mat(u, KIND[role], role === 'tester' ? 0.11 : 0))
    bodyG.add(body, face, hat)
    g.add(bodyG)
    // eyes
    const eyes: Eye[] = [-1, 1].map((s) => {
      const e = new T.Group()
      const open = new T.Group()
      const w = sph(1, flat('#ffffff'), [0.19, 0.25, 0.05])
      const pu = new T.Group()
      pu.add(sph(1, flat('#1b1133'), [0.108, 0.145, 0.03]))
      const gl = sph(1, flat('#ffffff'), [0.036, 0.046, 0.02])
      gl.position.set(0.035, 0.055, 0.035)
      pu.add(gl)
      pu.position.z = 0.045
      open.add(w, pu)
      const arc = tor(0.16, 0.034, flat('#ffffff'), Math.PI)
      e.add(open, arc)
      on(e, s * 0.33, 0.02, role === 'tester' ? 1.045 : 1.005)
      face.add(e)
      return { open, pu, arc }
    })
    const mouth = sph(1, flat('#1b1133'), [0.11, 0.09, 0.03])
    on(mouth, 0, -0.26, role === 'tester' ? 1.03 : 1.0)
    mouth.visible = false
    face.add(mouth)
    const handM = mat(u, 0)
    const hl = sph(0.21, handM)
    const hr = sph(0.21, handM)
    g.add(hl, hr)
    const tools = {} as Record<ToolName, Tool>
    const add = (k: ToolName, o: THREE.Group, par: 'r' | 'w' = 'r') => {
      tools[k] = { o, par }
      g.add(o)
      o.visible = false
    }
    // what each one wears
    if (role === 'builder') {
      const cap = M(new T.SphereGeometry(1.07, 48, 24, 0, Math.PI * 2, 0, Math.PI * 0.34), prop(...GOLD, u))
      const brim = cyl(1.02, 1.1, 0.08, prop(...GOLD, u), 56)
      const ridge = tor(1.07, 0.07, prop(...GOLD, u), Math.PI * 0.62)
      brim.position.y = 0.52
      brim.scale.z = 1.12
      brim.position.z = 0.06
      ridge.rotation.set(0, Math.PI / 2, 0)
      ridge.rotation.order = 'YXZ'
      ridge.rotation.z = Math.PI * 0.19
      hat.add(cap, brim, ridge)
      hat.rotation.set(-0.2, 0, -0.07)
    }
    if (role === 'planner') {
      const b = sph(1, prop('#b9c8ff', '#4a62d8', '#1c2a78', u), [0.86, 0.3, 0.86])
      b.position.set(-0.14, 0.95, 0.04)
      b.rotation.z = 0.2
      const st = cyl(0.04, 0.05, 0.18, prop('#b9c8ff', '#4a62d8', '#1c2a78', u))
      st.position.set(-0.2, 1.3, 0.04)
      hat.add(b, st)
    }
    let specs: THREE.Group | undefined
    let ring: THREE.Group | undefined
    if (role === 'reviewer') {
      ring = new T.Group()
      const rm = mat({ ...u, L: propL })
      const r1 = tor(1.66, 0.08, rm)
      const r2 = tor(1.45, 0.034, rm)
      for (const r of [r1, r2]) r.scale.z = 0.35
      ring.add(r1, r2)
      ring.rotation.set(1.28, -0.2, 0)
      g.add(ring)
      specs = new T.Group()
      for (const s of [-1, 1]) {
        const q = new T.Group()
        const gls = M(new T.CircleGeometry(0.3, 36), flat('#dfe8ff', 0.16))
        const fr = tor(0.31, 0.05, prop(...GOLD))
        q.add(gls, fr)
        on(q, s * 0.345, 0.02, 1.12)
        specs.add(q)
      }
      const br = tor(0.1, 0.04, prop(...GOLD), Math.PI)
      on(br, 0, 0.06, 1.14)
      specs.add(br)
      face.add(specs)
    }
    if (role === 'tester') {
      const strap = tor(1.03, 0.075, prop('#8fa0c8', '#46527c', '#1c2340', u))
      strap.rotation.x = Math.PI / 2 - 0.42
      strap.position.y = 0.42
      strap.scale.set(0.93, 0.93, 1.4)
      hat.add(strap)
      for (const s of [-1, 1]) {
        const q = new T.Group()
        q.add(tor(0.25, 0.07, prop(...GOLD, u)), M(new T.CircleGeometry(0.25, 32), flat('#8ff5dc', 0.55)))
        on(q, s * 0.3, 0.62, 1.05)
        hat.add(q)
      }
    }
    // tools
    const hammer = new T.Group()
    const hd = M(new T.CapsuleGeometry(0.2, 0.36, 6, 20), prop(...STEEL))
    const hh = cyl(0.06, 0.075, 1.05, prop(...WOOD))
    const band = cyl(0.1, 0.1, 0.12, prop(...GOLD))
    hh.position.y = 0.42
    hd.rotation.z = Math.PI / 2
    hd.position.y = 0.96
    band.position.y = 0.76
    hammer.add(hh, hd, band)
    add('hammer', hammer)
    const block = new T.Group()
    const bk = M(new T.BoxGeometry(0.6, 0.46, 0.6), prop('#fff6ff', '#ffb6cf', '#8a4a72'))
    block.add(bk)
    add('block', block, 'w')
    const doc = new T.Group()
    const dp = paper((c) => {
      c.fillStyle = '#f7f4ff'
      c.fillRect(0, 0, 200, 150)
      c.fillStyle = '#b9b0dc'
      for (let i = 0; i < 7; i++) c.fillRect(18, 18 + i * 17, 90 + ((i * 53) % 70), 7)
    })
    dp.paper.draw()
    doc.add(M(new T.PlaneGeometry(1.15, 0.86), new T.MeshBasicMaterial({ map: dp.tx, side: T.DoubleSide })))
    add('doc', doc, 'w')
    const sheet = new T.Group()
    const pts: [number, number][] = [[24, 112], [58, 50], [92, 92], [128, 34], [172, 70]]
    const sp = paper((c, q) => {
      c.fillStyle = '#101a3c'
      c.fillRect(0, 0, 200, 150)
      c.strokeStyle = '#3b4f95'
      c.lineWidth = 1
      for (let i = 1; i < 6; i++) {
        c.beginPath()
        c.moveTo(i * 34, 0)
        c.lineTo(i * 34, 150)
        c.moveTo(0, i * 26)
        c.lineTo(200, i * 26)
        c.stroke()
      }
      c.strokeStyle = '#9fd4ff'
      c.lineWidth = 4
      c.lineCap = 'round'
      c.beginPath()
      c.moveTo(pts[0]![0], pts[0]![1])
      const k = q * (pts.length - 1)
      for (let i = 0; i < pts.length - 1; i++) {
        const f = clamp(k - i)
        if (f <= 0) break
        const a = pts[i]!
        const b = pts[i + 1]!
        c.lineTo(lerp(a[0], b[0], f), lerp(a[1], b[1], f))
      }
      c.stroke()
      pts.forEach((p, i) => {
        c.fillStyle = k >= i ? '#fff' : '#5a6fb5'
        c.beginPath()
        c.arc(p[0], p[1], k >= i ? 7 : 4, 0, TAU)
        c.fill()
      })
    })
    sheet.add(M(new T.PlaneGeometry(1.5, 1.12), new T.MeshBasicMaterial({ map: sp.tx, side: T.DoubleSide })))
    const pencil = new T.Group()
    const pb = cyl(0.07, 0.07, 0.62, prop(...GOLD), 6)
    const pt = cyl(0.07, 0.012, 0.17, prop(...CREAM), 6)
    const pe = cyl(0.075, 0.075, 0.1, prop('#ffd6e2', '#f5487f', '#7a2350'), 12)
    pb.position.y = 0.47
    pt.position.y = 0.085
    pe.position.y = 0.82
    pencil.add(pb, pt, pe)
    sheet.add(pencil)
    add('sheet', sheet, 'w')
    const flask = new T.Group()
    const prof = (a: [number, number][]) => a.map(([x, y]) => new T.Vector2(x, y))
    const glass = M(new T.LatheGeometry(prof([[0, 0], [0.44, 0], [0.47, 0.07], [0.17, 0.62], [0.14, 0.68], [0.14, 0.92], [0.2, 0.95]]), 40), flat('#c4ecff', 0.42))
    const liq = M(new T.LatheGeometry(prof([[0, 0.04], [0.39, 0.04], [0.4, 0.08], [0.24, 0.42], [0, 0.42]]), 40), prop('#eafff8', '#31e0b4', '#0c7a60'))
    const bubbles = [0, 1, 2].map(() => sph(0.055, flat('#eafff8', 0.9)))
    flask.add(liq, ...bubbles, glass)
    flask.children.forEach((x) => (x.position.y -= 0.8))
    add('flask', flask)
    const orb = new T.Group()
    orb.add(sph(0.25, flat('#ffffff')), sph(0.36, flat('#ffffff', 0.25)))
    add('orb', orb, 'w')
    return { g, bodyG, u, eyes, mouth, hl, hr, tools, specs, ring, block: bk, sheetPaper: sp.paper, sheetPts: pts, pencil, bubbles }
  }

  const mem = new Map<string, Memory>()
  const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())
  let lastPrune = nowMs()
  function prune(now: number) {
    if (now - lastPrune < 5000) return
    lastPrune = now
    for (const [k, m] of mem) if (now - m.seen > FORGET_MS) mem.delete(k)
  }

  /** The pose for this moment: where hands, head and tools are, eased from the last pose of the same key. Returns what the 2D canvas adds. */
  function pose(R: Rig, o: DrawMoon): Fx {
    const s: MoonState = o.state
    const still = o.calm
    const t = still ? 1.02 : o.t
    const T_ = R.tools
    const S = Math.sin
    const P: Pose = { lx: -1.02, ly: -0.5, lz: 0.5, rx: 1.02, ry: -0.5, rz: 0.5, yaw: o.look * 0.34, tilt: 0, lean: 0, by: 0.03 * S(t * 1.7), sq: 1, px: 0.04 * o.look, py: 0, lid: 1, sleep: 0, happy: 0, specs: 1, mouth: 0 }
    const show = new Set<ToolName>()
    let fx: Fx = null
    if (s === 'rest') Object.assign(P, { lx: -0.62, ly: -0.86, lz: 0.5, rx: 0.62, ry: -0.86, rz: 0.5, yaw: 0, sleep: 1, tilt: 0.1 + 0.03 * S(t * 0.8), by: 0.02 * S(t * 1.1), sq: 1 + 0.016 * S(t * 1.1), specs: 0 })
    if (s === 'idle') P.py = 0.01
    if (s === 'think') Object.assign(P, { rx: 0.42, ry: -0.84, rz: 0.86, yaw: 0.16 * S(t * 0.7), tilt: 0.08, px: 0.05 * S(t * 0.9), py: 0.075 })
    if (s === 'read') {
      show.add('doc')
      Object.assign(P, { lx: 0.28, ly: -0.98, lz: 1.0, rx: 1.5, ry: -0.92, rz: 0.6, yaw: o.look * 0.24, px: 0.03 + 0.055 * S(t * 2.6), py: -0.085, lean: 0.12 })
    }
    const work = s === 'edit' ? (o.role === 'planner' ? 'draw' : o.role === 'tester' ? 'flask' : o.role === 'reviewer' ? 'doc' : 'hammer') : s === 'run' ? (o.role === 'tester' ? 'flask' : 'watch') : ''
    if (work === 'doc') {
      show.add('doc')
      Object.assign(P, { lx: 0.12, ly: -0.62, lz: 1.05, rx: 1.42, ry: -0.6, rz: 0.6, py: -0.07 })
    }
    if (work === 'hammer') {
      show.add('hammer')
      show.add('block')
      const D = 0.86
      const c = still ? 0.4 : (t / D) % 1
      let a: number
      let hit = 0
      if (c < 0.48) a = lerp(-1.1, 0.62, out(c / 0.48))
      else if (c < 0.6) {
        const q = (c - 0.48) / 0.12
        a = lerp(0.62, -1.32, q * q)
      } else if (c < 0.7) a = -1.32 + 0.16 * S(((c - 0.6) / 0.1) * Math.PI)
      else a = lerp(-1.32, -1.1, (c - 0.7) / 0.3)
      if (c >= 0.6) hit = (c - 0.6) * D
      Object.assign(P, { yaw: o.look * 0.2, rx: 1.2, ry: -0.42 + (c > 0.48 && c < 0.62 ? -0.12 : 0), rz: 0.45, lx: -1.0, ly: -0.5, px: 0.07, py: -0.05, lean: c > 0.5 && c < 0.68 ? 0.1 : 0, tilt: c < 0.48 ? 0.07 * out(c / 0.48) : -0.06, lid: c > 0.56 && c < 0.68 ? 0.55 : 1 })
      T_.hammer.o.rotation.set(0, 0, a - 0.06)
      const b = T_.block.o
      b.position.set(1.98, -0.86, 0.4)
      b.rotation.y = 0.5
      const sq = hit ? Math.exp(-hit * 16) : 0
      R.block.scale.set(1 + sq * 0.2, 1 - sq * 0.3, 1 + sq * 0.2)
      fx = hit > 0 && hit < 0.4 ? { k: 'spark', age: hit, x: 2.0, y: -0.58 } : null
    }
    if (work === 'draw') {
      show.add('sheet')
      const sh = T_.sheet.o
      const q = still ? 0.62 : clamp((t * 0.3) % 1.25)
      const pts = R.sheetPts
      const k = q * (pts.length - 1)
      const i = Math.min(pts.length - 2, Math.floor(k))
      const f = k - i
      const p0 = pts[i]!
      const p1 = pts[i + 1]!
      const X = (lerp(p0[0], p1[0], f) / 200 - 0.5) * 1.5
      const Y = (0.5 - lerp(p0[1], p1[1], f) / 150) * 1.12
      R.sheetPaper.draw(q)
      sh.position.set(1.38, -0.86, 0.85)
      sh.rotation.set(-0.5, -0.28, 0.05)
      R.pencil.position.set(X, Y, 0.02)
      R.pencil.rotation.set(0.55, 0, -0.6 + 0.08 * S(t * 9))
      const grip = V3(X + 0.3, Y + 0.42, 0.3).applyEuler(sh.rotation).add(sh.position)
      Object.assign(P, { rx: grip.x, ry: grip.y, rz: grip.z, lx: 0.56, ly: -1.12, lz: 1.0, yaw: o.look * 0.24, px: 0.05 + X * 0.03, py: -0.08, lean: 0.12 })
    }
    if (work === 'flask') {
      show.add('flask')
      const w = s === 'run' ? S(t * 11) * 0.34 : S(t * 3) * 0.12
      Object.assign(P, { rx: 1.24, ry: 0.28 + 0.05 * S(t * 5), rz: 0.6, px: 0.07, py: 0.02, lid: s === 'run' ? 1.06 : 1 })
      T_.flask.o.rotation.z = w
      R.bubbles.forEach((b, i) => {
        const q = still ? 0.4 + i * 0.2 : (t * 0.7 + i / 3) % 1
        b.position.set(S(t * 4 + i * 2) * 0.1, -0.66 + q * 1.1, 0.1)
        b.scale.setScalar(1 - q * 0.5)
      })
    }
    if (work === 'watch') Object.assign(P, { lx: -0.92, ly: -0.5 + 0.1 * S(t * 7), rx: 1.04, ry: -0.5 - 0.1 * S(t * 7), px: 0.07, lid: 1.06, by: 0.035 * S(t * 7) })
    if (s === 'lens') {
      const w = S(t * 1.6)
      Object.assign(P, { rx: 1.3 + 0.1 * w, ry: -0.02 + 0.1 * S(t * 2.3), rz: 0.75, px: 0.045 + 0.05 * w, py: 0.03 * S(t * 2.3), lean: 0.14, lid: 0.8, yaw: o.look * 0.34 + 0.07 * w })
    }
    if (s === 'found') {
      const j = Math.abs(S(t * 4.2))
      Object.assign(P, { rx: 0.98, ry: 0.92, rz: 0.5, lx: -1.06, ly: -0.1, by: still ? 0.05 : 0.13 * j, lid: 1.22, py: 0.03 })
      fx = { k: 'bang', x: 0.98, y: 1.5 }
    }
    if (s === 'hand') {
      show.add('orb')
      Object.assign(P, { lx: -0.46, ly: 1.16, lz: 0.55, rx: 0.46, ry: 1.16, rz: 0.55, py: 0.09, px: 0.05 * o.look })
      T_.orb.o.position.set(0, 1.5 + 0.04 * S(t * 4), 0.55)
      fx = { k: 'orb', x: 0, y: 1.5 }
    }
    if (s === 'wait') Object.assign(P, { yaw: 0, rx: 1.06 + 0.16 * S(t * 5.2), ry: 0.82, rz: 0.5, lx: -0.98, ly: -0.55, px: 0, py: 0.02, lid: 1.14, tilt: -0.07 })
    if (s === 'talk') {
      const v = still ? 0.6 : Math.abs(S(t * 9.3) * S(t * 4.1 + 1))
      Object.assign(P, { mouth: 0.25 + 0.75 * v, rx: 1.08 + 0.12 * S(t * 3.1), ry: -0.1 + 0.26 * S(t * 3.7), rz: 0.75, lx: -1, ly: -0.42 + 0.14 * S(t * 2.9 + 1), by: 0.035 * S(t * 6.2), tilt: 0.05 * S(t * 2.3), px: 0.06, py: 0.012, yaw: 0.36 })
    }
    if (s === 'listen') Object.assign(P, { lx: -0.9, ly: -0.72, rx: 0.9, ry: -0.72, rz: 0.6, lean: 0.05 + 0.06 * Math.max(0, S(t * 2.4)), tilt: 0.05, px: 0.07, yaw: 0.34 })
    if (s === 'found') P.mouth = 0.7
    if (s === 'done') {
      const b = still ? 0.3 : Math.abs(S(t * 3.1))
      Object.assign(P, { lx: -1.12, ly: 0.5 + 0.1 * b, rx: 1.12, ry: 0.5 + 0.1 * b, by: 0.09 * b, happy: 1, tilt: 0.05 * S(t * 3.1) })
    }
    if (s === 'agree') Object.assign(P, { lx: -1, ly: -0.4, rx: 1.06, ry: 0.86, rz: 0.6, happy: 1, yaw: 0.3, by: 0.04 * S(t * 3) })
    // each one eases from what it was doing to what it does now
    let m = mem.get(o.key)
    const fresh = !m
    if (!m) {
      m = { P: { ...P }, tool: {}, seen: 0 }
      mem.set(o.key, m)
    }
    m.seen = nowMs()
    const k = fresh || still ? 1 : 1 - Math.exp(-o.dt * 15)
    for (const q of POSE_KEYS) m.P[q] += (P[q] - m.P[q]) * k
    const p = m.P
    const bl = !still && (t + (o.seed ?? 0)) % 3.9 < 0.12 ? 0.1 : 1
    R.bodyG.rotation.set(p.lean, p.yaw, p.tilt)
    R.bodyG.position.y = p.by
    R.bodyG.scale.set(2 - p.sq, p.sq, 2 - p.sq)
    R.hl.position.set(p.lx, p.ly + p.by * 0.6, p.lz)
    R.hr.position.set(p.rx, p.ry + p.by * 0.6, p.rz)
    for (const e of R.eyes) {
      const shut = p.sleep > 0.5 || p.happy > 0.5
      e.open.visible = !shut
      e.arc.visible = shut
      e.arc.rotation.z = p.sleep > 0.5 ? Math.PI : 0
      e.arc.material.color.set(p.sleep > 0.5 ? o.color.hi : '#1b1133')
      e.open.scale.set(1, clamp(p.lid, 0.1, 1.3) * bl, 1)
      e.pu.position.x = p.px
      e.pu.position.y = p.py
    }
    R.mouth.visible = p.mouth > 0.08
    R.mouth.scale.set(0.085 + 0.035 * p.mouth, 0.015 + 0.1 * p.mouth, 0.03)
    if (R.specs) R.specs.rotation.x = -(1 - p.specs) * 0.62
    if (R.ring) {
      R.ring.position.y = p.by
      R.ring.rotation.z = s === 'lens' ? 0.16 * S(t * 1.4) : 0.05 * S(t * 0.5)
    }
    for (const n of TOOL_NAMES) {
      const x = T_[n]
      const want = show.has(n) ? 1 : 0
      const q = m.tool[n] ?? want
      const v = q + (want - q) * k
      m.tool[n] = v
      x.o.visible = v > 0.03
      x.o.scale.setScalar(Math.max(0.01, v))
      if (x.par === 'r') x.o.position.copy(R.hr.position)
    }
    if (show.has('doc')) {
      const d = T_.doc.o
      d.position.set(0.94, -0.88, 1.0)
      d.rotation.set(-0.5, -0.12, 0.04)
    }
    return fx
  }

  const nightTarget = { dark: cl('#0b0818'), light: cl('#7d74a6') }
  /** Renders the character to the shared offscreen canvas. */
  function render(o: DrawMoon): Fx {
    let R = rigs.get(o.role)
    if (!R) {
      R = makeRig(o.role)
      rigs.set(o.role, R)
    }
    const u = R.u
    const light = o.theme === 'light'
    u.hi.value.set(o.color.hi)
    u.mid.value.set(o.color.mid)
    u.lo.value.set(o.color.lo)
    u.night.value.set(o.color.lo).lerp(nightTarget[o.theme], light ? 0.3 : 0.68)
    u.lit.value = o.lit
    u.t.value = o.calm ? 1 : o.t
    // A moon that waits for the person is a dark disc with a ring of light, so its light comes from behind.
    const a = Math.acos(clamp(2 * (o.state === 'wait' ? 0.03 : o.phase) - 1, -1, 1))
    u.L.value.set(Math.sin(a), 0.24, Math.cos(a)).normalize()
    const fx = pose(R, o)
    if (scene.children[0] !== R.g) {
      scene.clear()
      scene.add(R.g)
    }
    rn.render(scene, cam)
    return fx
  }

  const giveUp = (error: unknown) => {
    if (!broken) console.warn('The characters failed to draw; the plain moons are used from now on.', error)
    broken = true
  }
  const usable = () => !(broken || lost || disposed)

  /** Everything around the picture: the halo, the pulses and the eclipse ring behind it, then the picture, then what sits in front of it. */
  function paint(c: CanvasRenderingContext2D, o: DrawMoon, fx: Fx) {
    const { r, state: st } = o
    const t = o.t + (o.flip ? 0.43 : 0)
    const col = o.color
    const live = o.calm ? 0 : 1
    const fl = o.flip ? -1 : 1
    const halo = o.theme === 'light' ? 0.34 : 0.5
    c.translate(o.x, o.y)
    const hr = r * (st === 'wait' ? 2.2 : 2.1 + live * 0.1 * Math.sin(t * 1.7))
    const h = c.createRadialGradient(0, 0, r * 0.6, 0, 0, hr)
    h.addColorStop(0, `rgba(${col.g},${halo * 0.85 * o.lit})`)
    h.addColorStop(1, `rgba(${col.g},0)`)
    c.fillStyle = h
    c.beginPath()
    c.arc(0, 0, hr, 0, TAU)
    c.fill()
    if (st === 'run' || st === 'found') {
      for (let i = 0; i < 3; i++) {
        const q = o.calm ? (i + 1) / 3.4 : (t * (st === 'found' ? 1 : 0.55) + i / 3) % 1
        c.beginPath()
        c.arc(0, 0, r * (1.2 + q * 1.15), 0, TAU)
        c.strokeStyle = `rgba(${col.g},${0.5 * (1 - q) * o.lit})`
        c.lineWidth = 1.4
        c.stroke()
      }
    }
    if (st === 'wait') {
      const q = 0.5 + 0.5 * Math.sin(t * 2.1) * live
      for (let i = 5; i > 0; i--) {
        c.beginPath()
        c.arc(0, 0, r * 1.0 + i * 0.5, 0, TAU)
        c.strokeStyle = `rgba(${col.g},${0.16 + 0.1 * q})`
        c.lineWidth = i * 3.6
        c.stroke()
      }
      c.beginPath()
      c.arc(0, 0, r * 1.02, 0, TAU)
      c.strokeStyle = col.hi
      c.lineWidth = 2.4
      c.stroke()
    }
    const S = 2 * EXT * r
    // Mirrored by scaling and scaled back after, so that nothing is left to restore if a call in between throws.
    c.scale(fl, 1)
    c.drawImage(canvas, -S / 2, -S / 2, S, S)
    if (st === 'wait') {
      const gx = r * 0.74
      const gy = -r * 0.72
      const d = c.createRadialGradient(gx, gy, 0, gx, gy, r * 0.42)
      d.addColorStop(0, '#fff')
      d.addColorStop(0.3, `rgba(${col.g},.85)`)
      d.addColorStop(1, `rgba(${col.g},0)`)
      c.fillStyle = d
      c.beginPath()
      c.arc(gx, gy, r * 0.42, 0, TAU)
      c.fill()
    }
    if (fx?.k === 'spark') {
      const q = fx.age / 0.4
      for (let i = 0; i < 11; i++) {
        const a = -Math.PI * (0.08 + 0.84 * (i / 10))
        const v = r * (0.5 + (0.55 * ((i * 37) % 10)) / 10)
        const x = fx.x * r + Math.cos(a) * v * out(q)
        const y = -fx.y * r + Math.sin(a) * v * out(q) + r * 0.7 * q * q
        c.beginPath()
        c.arc(x, y, Math.max(0.4, r * 0.055 * (1 - q)), 0, TAU)
        c.fillStyle = i % 3 ? `rgba(255,214,120,${1 - q})` : `rgba(255,255,255,${1 - q})`
        c.fill()
      }
      const g = c.createRadialGradient(fx.x * r, -fx.y * r, 0, fx.x * r, -fx.y * r, r * 0.7)
      g.addColorStop(0, `rgba(255,225,150,${0.6 * (1 - q) * (1 - q)})`)
      g.addColorStop(1, 'rgba(255,225,150,0)')
      c.fillStyle = g
      c.beginPath()
      c.arc(fx.x * r, -fx.y * r, r * 0.7, 0, TAU)
      c.fill()
    }
    if (fx?.k === 'orb') {
      const g = c.createRadialGradient(0, -fx.y * r, 0, 0, -fx.y * r, r * 0.8)
      g.addColorStop(0, `rgba(${col.g},.75)`)
      g.addColorStop(1, `rgba(${col.g},0)`)
      c.fillStyle = g
      c.beginPath()
      c.arc(0, -fx.y * r, r * 0.8, 0, TAU)
      c.fill()
    }
    c.scale(fl, 1)
    c.textAlign = 'center'
    c.textBaseline = 'alphabetic'
    if (fx?.k === 'bang') {
      c.fillStyle = col.hi
      c.font = `600 ${Math.round(r * 0.62)}px ${FONT}`
      c.fillText('!', fl * fx.x * r, -fx.y * r + r * 0.14)
    }
    if (st === 'rest' && live) {
      c.textAlign = 'left'
      c.fillStyle = col.hi
      for (let i = 0; i < 3; i++) {
        const q = (t * 0.28 + i / 3) % 1
        c.globalAlpha = Math.sin(q * Math.PI) * 0.6
        c.font = `400 ${Math.round(r * (0.2 + 0.18 * q))}px ${FONT}`
        c.fillText('z', r * (0.75 + 0.35 * q), -r * (0.75 + 0.85 * q))
      }
      c.globalAlpha = 1
    }
    if (st === 'think') {
      const ps = [0, 1, 2, 3].map((i): [number, number] => {
        const a = -1.9 + i * 0.42 + 0.08 * Math.sin(t * live * 1.1 + i)
        return [Math.cos(a) * r * (1.62 + 0.1 * Math.sin(t * live * 1.4 + i * 2)), Math.sin(a) * r * 1.62]
      })
      c.strokeStyle = `rgba(${col.g},.7)`
      c.lineWidth = 1.2
      ps.forEach((p, i) => {
        if (!i) return
        const prev = ps[i - 1]!
        c.globalAlpha = o.calm ? 1 : clamp(0.5 + Math.sin(t * 1.4 - i))
        c.beginPath()
        c.moveTo(prev[0], prev[1])
        c.lineTo(p[0], p[1])
        c.stroke()
      })
      c.globalAlpha = 1
      c.fillStyle = col.hi
      for (const p of ps) {
        c.beginPath()
        c.arc(p[0], p[1], Math.max(1.6, r * 0.065), 0, TAU)
        c.fill()
      }
    }
  }

  return {
    draw(ctx, o) {
      if (!usable()) {
        drawPlainMoon(ctx, o)
        return
      }
      let fx: Fx
      try {
        if (rn.getContext().isContextLost()) {
          gone()
          drawPlainMoon(ctx, o)
          return
        }
        prune(nowMs())
        fx = render(o)
      } catch (error) {
        giveUp(error)
        drawPlainMoon(ctx, o)
        return
      }
      // The context is saved once here, so if a call throws half way its state is put back before the plain moon is drawn.
      let painted = false
      ctx.save()
      try {
        paint(ctx, o, fx)
        painted = true
      } catch (error) {
        giveUp(error)
      } finally {
        ctx.restore()
      }
      if (!painted) drawPlainMoon(ctx, o)
    },

    snapshot(role, color, theme, size) {
      if (!usable()) return ''
      const key = `snap:${role}:${color.mid}:${theme}`
      try {
        render({ x: 0, y: 0, r: 1, role, color, state: 'idle', phase: 0.9, lit: 1, t: 0, dt: 1, look: 0, key, calm: true, theme })
        mem.delete(key)
        const c = document.createElement('canvas')
        c.width = c.height = size
        const g = c.getContext('2d')
        if (!g) return ''
        const q = Q / (2 * EXT)
        const w = 2 * 1.5 * q
        g.drawImage(canvas, Q / 2 - w / 2, Q / 2 - w / 2 - 0.12 * q, w, w, 0, 0, size, size)
        // A renderer that lost its context draws nothing and says nothing: an empty face is never given out.
        if ((g.getImageData(size >> 1, size >> 1, 1, 1).data[3] ?? 0) === 0) {
          gone()
          return ''
        }
        return c.toDataURL()
      } catch (error) {
        giveUp(error)
        return ''
      }
    },

    dispose() {
      if (disposed) return
      disposed = true
      canvas.removeEventListener('webglcontextlost', gone)
      for (const R of rigs.values()) {
        R.g.traverse((obj) => {
          const mesh = obj as THREE.Mesh
          if (!mesh.isMesh) return
          mesh.geometry.dispose()
          const ms = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
          for (const m of ms) {
            const map = (m as THREE.MeshBasicMaterial).map
            if (map) map.dispose()
            m.dispose()
          }
        })
      }
      rigs.clear()
      mem.clear()
      scene.clear()
      rn.dispose()
      if (!rn.getContext().isContextLost()) rn.forceContextLoss()
      T.ColorManagement.enabled = previousManagement
    }
  }
}
