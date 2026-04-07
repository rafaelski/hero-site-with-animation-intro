// =============================================================================
// FIDENZA EMBED — Sphere Illusion + Preset Lerp System
// =============================================================================
//
// COMO FUNCIONA:
//   Todas as físicas (flow field, atrator, repulsão, grid espacial) rodam em
//   espaço 2D plano. A função toSphere() projeta as posições 2D para a
//   superfície de uma esfera apenas no momento do render — criando a ilusão
//   de 3D sem quebrar a interação hover/repulsão.
//
// MODOS:
//   ?edit=true  → abre painel lateral completo de edição de parâmetros
//   (padrão)    → mostra apenas o slider de cenas para o usuário
//
// INTEGRAÇÃO COM INTRO (index.html):
//   O slider fica parado até receber window._introSignal = true.
//   Esse sinal é disparado pelo index.html quando o cursor da intro
//   chega ao terceiro ponto de interação.
// =============================================================================

// Detecta modo de edição via query string
const EDIT_MODE = new URLSearchParams(window.location.search).get('edit') === 'true';


// ── PARÂMETROS GLOBAIS ────────────────────────────────────────────────────────
// Valores default — sobrescritos por applyState() quando um preset é carregado

let CANVAS_W    = 800;
let CANVAS_H    = 800;

// Flow field (campo de fluxo Perlin que guia as partículas)
let FIELD_SCALE     = 0.0018;   // frequência espacial do campo
let FIELD_ANGLE     = 3.14159;  // amplitude angular do campo
let FIELD_EVOLUTION = 0.0003;   // velocidade de evolução temporal

// Repulsão entre partículas (evita sobreposição)
let REPULSION_RADIUS   = 30;
let REPULSION_STRENGTH = 0.8;

// Partículas
let NUM_PARTICLES = 800;
let TRAIL_LENGTH  = 10;   // quantos pontos compõem a cauda
let MIN_WIDTH     = 4;    // espessura mínima do traço (px)
let MAX_WIDTH     = 18;   // espessura máxima do traço (px)
let SPEED         = 4.0;
let WRAP_EDGES    = true; // partículas que saem de um lado reaparecem no outro

// Atrator (segue o mouse e orbita as partículas ao redor)
let ATTRACTOR_RADIUS   = 180;
let ATTRACTOR_STRENGTH = 2.5;
let ATTRACTOR_DECAY    = 0.015; // quão rápido o atrator perde força após o mouse parar
let ORBIT_DISTANCE     = 60;    // distância de órbita preferida em torno do cursor

// Estilo visual
let DRAW_STYLE  = 'solid'; // 'solid' | 'soft' | 'outlined'
let SOFT_LINES  = 8;       // usado apenas no modo 'soft' (não implementado no render atual)
let FADE_TAIL   = true;    // se true, a cauda afina em direção à ponta

// Paleta de cores (cada entrada: [R, G, B, probabilidade])
let PALETTE = [
  [210, 80,  50,  0.28],
  [60,  110, 190, 0.28],
  [220, 185, 50,  0.16],
  [190, 190, 190, 0.16],
  [40,  40,  40,  0.12],
];

// Paletas predefinidas disponíveis no painel de edição
const PALETTES_PRESET = {
  'clássico':      [[210,80,50,0.28],[60,110,190,0.28],[220,185,50,0.16],[190,190,190,0.16],[40,40,40,0.12]],
  'pastel':        [[255,180,180,0.25],[180,220,255,0.25],[180,255,200,0.20],[255,240,180,0.20],[220,180,255,0.10]],
  'monocromático': [[30,30,30,0.30],[80,80,80,0.25],[140,140,140,0.25],[200,200,200,0.15],[240,240,240,0.05]],
  'vibrante':      [[255,50,50,0.25],[50,200,100,0.25],[50,100,255,0.20],[255,200,0,0.20],[200,0,200,0.10]],
  'terra':         [[180,100,40,0.30],[140,80,30,0.25],[200,160,80,0.20],[100,70,40,0.15],[230,200,140,0.10]],
  'oceano':        [[20,80,140,0.30],[40,140,180,0.25],[80,200,200,0.20],[20,40,80,0.15],[160,220,230,0.10]],
};

// Modificadores de cor aplicados sobre a paleta em tempo de render
let SAT_MULT   = 1.0; // multiplicador de saturação (1 = original)
let LIGHT_MULT = 1.0; // multiplicador de luminosidade

// Fundo
let BG_COLOR     = [245, 240, 228]; // RGB
let BG_FADE      = false;           // se true, fundo semi-transparente cria rastro
let BG_FADE_ALPHA = 20;             // alpha do retângulo de fundo no modo BG_FADE

// Seed do gerador de números aleatórios
let USE_FIXED_SEED = false;
let FIXED_SEED     = 42;

// Estado do atrator (segue o mouse)
let attractor = { x: 0, y: 0, strength: 0, active: false };

// Pool de partículas e grid espacial para otimização da repulsão
let particles   = [];
let spatialGrid = { cells: {}, cell: 30 };

// Referência ao elemento do painel de edição (preenchida por buildEditUI)
let panel;


// ── ESFERA ────────────────────────────────────────────────────────────────────
/*
  A "esfera" é uma ilusão: as partículas se movem em espaço 2D,
  e toSphere() projeta cada ponto para a superfície de uma esfera 3D
  apenas na hora de desenhar. Isso mantém a física simples e correta.

  A projeção usa coordenadas esféricas:
    u ∈ [0,1] → longitude (φ), mapeado para θ = u*2π + rotY
    v ∈ [0,1] → latitude,     mapeado para φ = v*π
*/

let SPHERE_R_PCT = 0.38;  // raio como fração do menor lado da tela
let SPHERE_R_MIN = 120;   // raio mínimo em px
let SPHERE_R_MAX = 500;   // raio máximo em px
let SPHERE_R     = 260;   // raio atual (recalculado por calcSphereR)
let ROT_SPEED    = 0.0013; // velocidade de rotação automática (rad/frame)
let rotY         = 0;      // ângulo de rotação atual em Y

function calcSphereR() {
  return constrain(min(CANVAS_W, CANVAS_H) * SPHERE_R_PCT, SPHERE_R_MIN, SPHERE_R_MAX);
}

// Projeta ponto 2D (x,y) do canvas para coordenada 3D na superfície da esfera,
// retornando {px, py} (pixel na tela) e depth (profundidade normalizada -1 a 1)
function toSphere(x, y) {
  const u     = x / CANVAS_W;
  const v     = y / CANVAS_H;
  const theta = u * TWO_PI + rotY;
  const phi   = v * PI;
  const sx    = SPHERE_R * sin(phi) * cos(theta);
  const sy    = SPHERE_R * cos(phi);
  const sz    = SPHERE_R * sin(phi) * sin(theta);
  return { px: CANVAS_W / 2 + sx, py: CANVAS_H / 2 + sy, depth: sz / SPHERE_R };
}


// ── PRESETS DE CENA ───────────────────────────────────────────────────────────
/*
  O sistema de presets permite salvar e interpolar entre 5 estados completos
  da simulação. O slider do usuário navega entre eles suavemente via lerpState().

  Para criar novos presets:
    1. Abra com ?edit=true
    2. Ajuste os parâmetros
    3. Clique num dos botões P1–P5 para salvar
    4. Clique "📋 Mostrar JSON dos presets" e copie o resultado
    5. Substitua os arrays SCENE_DEFAULTS_DESKTOP e SCENE_DEFAULTS_MOBILE abaixo
*/

const SCENE_DEFAULTS_DESKTOP = [
  {
    "FIELD_SCALE": 0.0018, "FIELD_ANGLE": 5.17, "FIELD_EVOLUTION": 0.0005,
    "REPULSION_RADIUS": 65, "REPULSION_STRENGTH": 1.65,
    "NUM_PARTICLES": 1700, "TRAIL_LENGTH": 10, "MIN_WIDTH": 1.5, "MAX_WIDTH": 2,
    "SPEED": 1.2, "WRAP_EDGES": true,
    "ATTRACTOR_RADIUS": 430, "ATTRACTOR_STRENGTH": 16, "ATTRACTOR_DECAY": 0.008, "ORBIT_DISTANCE": 300,
    "FADE_TAIL": false, "BG_FADE": true, "BG_FADE_ALPHA": 60,
    "SAT_MULT": 1, "LIGHT_MULT": 1, "BG_COLOR": [15,14,23],
    "PALETTE": [[20,80,140,0.3],[40,140,180,0.25],[80,200,200,0.2],[20,40,80,0.15],[160,220,230,0.1]],
    "SPHERE_R_PCT": 0.38, "SPHERE_R_MIN": 120, "SPHERE_R_MAX": 500, "ROT_SPEED": 0
  },
  {
    "FIELD_SCALE": 0.0003385866799261537, "FIELD_ANGLE": 8.962326101978022, "FIELD_EVOLUTION": 0.0016930841826039563,
    "REPULSION_RADIUS": 70.9477978021978, "REPULSION_STRENGTH": 1.246243325186813,
    "NUM_PARTICLES": 1237, "TRAIL_LENGTH": 5, "MIN_WIDTH": 1.8529670329670322, "MAX_WIDTH": 5.7076483516483485,
    "SPEED": 1.2, "WRAP_EDGES": true,
    "ATTRACTOR_RADIUS": 420.5320128791209, "ATTRACTOR_STRENGTH": 13.074269919999999, "ATTRACTOR_DECAY": 0.011599823120175823, "ORBIT_DISTANCE": 46.395017952351644,
    "FADE_TAIL": false, "BG_FADE": true, "BG_FADE_ALPHA": 40.91067710417583,
    "SAT_MULT": 0.9986414153846154, "LIGHT_MULT": 1.0009704175824177, "BG_COLOR": [15,14,23],
    "PALETTE": [[68,68,68,0.18160734474164691],[67,74,80,0.21019346395471195],[117,142,142,0.20369410451547496],[166,195,201,0.18102243288826908],[200,230,239,0.22348265389989713]],
    "SPHERE_R_PCT": 0.44, "SPHERE_R_MIN": 108.08460616791209, "SPHERE_R_MAX": 432.402542596923, "ROT_SPEED": 0.0021781118382065935
  },
  {
    "FIELD_SCALE": 0.0017974006346308164, "FIELD_ANGLE": 5.671879031275745, "FIELD_EVOLUTION": 0.0003764197601861311,
    "REPULSION_RADIUS": 51.89936730979297, "REPULSION_STRENGTH": 1.2843383068280863,
    "NUM_PARTICLES": 284, "TRAIL_LENGTH": 8, "MIN_WIDTH": 9.352536932874541, "MAX_WIDTH": 27.982292317770405,
    "SPEED": 2.6912087912087914, "WRAP_EDGES": true,
    "ATTRACTOR_RADIUS": 359.93568594981303, "ATTRACTOR_STRENGTH": 13.52762744458418, "ATTRACTOR_DECAY": 0.017108383991137024, "ORBIT_DISTANCE": 68.01872551481429,
    "FADE_TAIL": false, "BG_FADE": false, "BG_FADE_ALPHA": 18.51802057774738,
    "SAT_MULT": 0.8801318990017183, "LIGHT_MULT": 1.0856200721416298, "BG_COLOR": [22,21,29],
    "PALETTE": [[241,237,235,0.09592813402193054],[29,64,94,0.3584034086957984],[27,145,137,0.3073281878996397],[19,152,178,0.09350395338431834],[45,182,228,0.144836315998313]],
    "SPHERE_R_PCT": 0.3, "SPHERE_R_MIN": 143.83812895036138, "SPHERE_R_MAX": 581.5746725474526, "ROT_SPEED": 0.0008515676779094782
  },
  {
    "FIELD_SCALE": 0.004500635032371199, "FIELD_ANGLE": 8.4728804512, "FIELD_EVOLUTION": 0.0015,
    "REPULSION_RADIUS": 44.774784000000004, "REPULSION_STRENGTH": 2.33263571968,
    "NUM_PARTICLES": 500, "TRAIL_LENGTH": 8, "MIN_WIDTH": 6.5299136, "MAX_WIDTH": 16.09001088,
    "SPEED": 4.5, "WRAP_EDGES": true,
    "ATTRACTOR_RADIUS": 309.28878288, "ATTRACTOR_STRENGTH": 8.866953068800001, "ATTRACTOR_DECAY": 0.009436665085440001, "ORBIT_DISTANCE": 35.99436121856,
    "FADE_TAIL": false, "BG_FADE": false, "BG_FADE_ALPHA": 9.6100556992,
    "SAT_MULT": 0.987797152, "LIGHT_MULT": 1.00871632, "BG_COLOR": [222,218,208],
    "PALETTE": [[213,96,69,0.26136644480000004],[57,105,180,0.2880590054691152],[201,180,58,0.17495236272],[172,187,189,0.15320672116426814],[40,54,59,0.12241546584661667]],
    "SPHERE_R_PCT": 0.38, "SPHERE_R_MIN": 132.2293078912, "SPHERE_R_MAX": 555.2017184128, "ROT_SPEED": 0
  },
  {
    "FIELD_SCALE": 0.0053, "FIELD_ANGLE": 6.75, "FIELD_EVOLUTION": 0.0054,
    "REPULSION_RADIUS": 54, "REPULSION_STRENGTH": 2.45,
    "NUM_PARTICLES": 1700, "TRAIL_LENGTH": 5, "MIN_WIDTH": 2, "MAX_WIDTH": 3.5,
    "SPEED": 1, "WRAP_EDGES": true,
    "ATTRACTOR_RADIUS": 465, "ATTRACTOR_STRENGTH": 14.3, "ATTRACTOR_DECAY": 0.012, "ORBIT_DISTANCE": 55,
    "FADE_TAIL": false, "BG_FADE": true, "BG_FADE_ALPHA": 20,
    "SAT_MULT": 1, "LIGHT_MULT": 1, "BG_COLOR": [245,240,228],
    "PALETTE": [[255,50,50,0.25],[50,200,100,0.25],[50,100,255,0.2],[255,200,0,0.2],[200,0,200,0.1]],
    "SPHERE_R_PCT": 0.38, "SPHERE_R_MIN": 110, "SPHERE_R_MAX": 450, "ROT_SPEED": 0
  }
];

// Versão mobile dos presets: mesmos visuais mas com menos partículas
// para manter a performance em dispositivos móveis
const SCENE_DEFAULTS_MOBILE = [
  {"FIELD_SCALE":0.0018,"FIELD_ANGLE":5.17,"FIELD_EVOLUTION":0.0005,"REPULSION_RADIUS":65,"REPULSION_STRENGTH":1.65,"NUM_PARTICLES":600,"TRAIL_LENGTH":10,"MIN_WIDTH":2.5,"MAX_WIDTH":4.2,"SPEED":0.2,"WRAP_EDGES":true,"ATTRACTOR_RADIUS":430,"ATTRACTOR_STRENGTH":16,"ATTRACTOR_DECAY":0.008,"ORBIT_DISTANCE":300,"FADE_TAIL":false,"BG_FADE":true,"BG_FADE_ALPHA":60,"SAT_MULT":1,"LIGHT_MULT":1,"BG_COLOR":[15,14,23],"PALETTE":[[20,80,140,0.3],[40,140,180,0.25],[80,200,200,0.2],[20,40,80,0.15],[160,220,230,0.1]],"SPHERE_R_PCT":0.38,"SPHERE_R_MIN":120,"SPHERE_R_MAX":500,"ROT_SPEED":0},
  {"FIELD_SCALE":0.0003385866799261537,"FIELD_ANGLE":8.962326101978022,"FIELD_EVOLUTION":0.0016930841826039563,"REPULSION_RADIUS":70.9477978021978,"REPULSION_STRENGTH":1.246243325186813,"NUM_PARTICLES":500,"TRAIL_LENGTH":5,"MIN_WIDTH":1.8529670329670322,"MAX_WIDTH":5.7076483516483485,"SPEED":0.2,"WRAP_EDGES":true,"ATTRACTOR_RADIUS":420.5320128791209,"ATTRACTOR_STRENGTH":13.074269919999999,"ATTRACTOR_DECAY":0.011599823120175823,"ORBIT_DISTANCE":46.395017952351644,"FADE_TAIL":false,"BG_FADE":true,"BG_FADE_ALPHA":40.91067710417583,"SAT_MULT":0.9986414153846154,"LIGHT_MULT":1.0009704175824177,"BG_COLOR":[15,14,23],"PALETTE":[[68,68,68,0.18160734474164691],[67,74,80,0.21019346395471195],[117,142,142,0.20369410451547496],[166,195,201,0.18102243288826908],[200,230,239,0.22348265389989713]],"SPHERE_R_PCT":0.44,"SPHERE_R_MIN":108.08460616791209,"SPHERE_R_MAX":432.402542596923,"ROT_SPEED":0.0021781118382065935},
  {"FIELD_SCALE":0.0017974006346308164,"FIELD_ANGLE":5.671879031275745,"FIELD_EVOLUTION":0.0003764197601861311,"REPULSION_RADIUS":51.89936730979297,"REPULSION_STRENGTH":1.2843383068280863,"NUM_PARTICLES":150,"TRAIL_LENGTH":8,"MIN_WIDTH":15,"MAX_WIDTH":40,"SPEED":1.7,"WRAP_EDGES":true,"ATTRACTOR_RADIUS":359.93568594981303,"ATTRACTOR_STRENGTH":13.52762744458418,"ATTRACTOR_DECAY":0.017108383991137024,"ORBIT_DISTANCE":68.01872551481429,"FADE_TAIL":false,"BG_FADE":false,"BG_FADE_ALPHA":18.51802057774738,"SAT_MULT":0.8801318990017183,"LIGHT_MULT":1.0856200721416298,"BG_COLOR":[22,21,29],"PALETTE":[[241,237,235,0.09592813402193054],[29,64,94,0.3584034086957984],[27,145,137,0.3073281878996397],[19,152,178,0.09350395338431834],[45,182,228,0.144836315998313]],"SPHERE_R_PCT":0.3,"SPHERE_R_MIN":143.83812895036138,"SPHERE_R_MAX":581.5746725474526,"ROT_SPEED":0.0008515676779094782},
  {"FIELD_SCALE":0.004500635032371199,"FIELD_ANGLE":8.4728804512,"FIELD_EVOLUTION":0.0015,"REPULSION_RADIUS":33,"REPULSION_STRENGTH":1.55,"NUM_PARTICLES":280,"TRAIL_LENGTH":8,"MIN_WIDTH":7,"MAX_WIDTH":17,"SPEED":2.9,"WRAP_EDGES":true,"ATTRACTOR_RADIUS":309.28878288,"ATTRACTOR_STRENGTH":8.866953068800001,"ATTRACTOR_DECAY":0.009436665085440001,"ORBIT_DISTANCE":35.99436121856,"FADE_TAIL":false,"BG_FADE":false,"BG_FADE_ALPHA":9.6100556992,"SAT_MULT":0.987797152,"LIGHT_MULT":1.00871632,"BG_COLOR":[222,218,208],"PALETTE":[[213,96,69,0.26136644480000004],[57,105,180,0.2880590054691152],[201,180,58,0.17495236272],[172,187,189,0.15320672116426814],[40,54,59,0.12241546584661667]],"SPHERE_R_PCT":0.38,"SPHERE_R_MIN":132.2293078912,"SPHERE_R_MAX":555.2017184128,"ROT_SPEED":0},
  {"FIELD_SCALE":0.0053,"FIELD_ANGLE":6.75,"FIELD_EVOLUTION":0.0054,"REPULSION_RADIUS":54,"REPULSION_STRENGTH":2.45,"NUM_PARTICLES":550,"TRAIL_LENGTH":5,"MIN_WIDTH":2,"MAX_WIDTH":3.5,"SPEED":0.25,"WRAP_EDGES":true,"ATTRACTOR_RADIUS":465,"ATTRACTOR_STRENGTH":14.3,"ATTRACTOR_DECAY":0.012,"ORBIT_DISTANCE":55,"FADE_TAIL":false,"BG_FADE":true,"BG_FADE_ALPHA":20,"SAT_MULT":1,"LIGHT_MULT":1,"BG_COLOR":[245,240,228],"PALETTE":[[255,50,50,0.25],[50,200,100,0.25],[50,100,255,0.2],[255,200,0,0.2],[200,0,200,0.1]],"SPHERE_R_PCT":0.38,"SPHERE_R_MIN":110,"SPHERE_R_MAX":450,"ROT_SPEED":0}
];

// Presets editáveis em runtime — inicializados com deep copy dos defaults
// (para não alterar os defaults quando o usuário salva um preset novo)
let SCENE_PRESETS = SCENE_DEFAULTS_DESKTOP.map(p => JSON.parse(JSON.stringify(p)));
let SCENE_POS     = 0; // posição atual no slider (0.0 a 4.0)

// Escolhe desktop ou mobile baseado na largura e aplica o preset 0
function _chooseAndApplyPresets() {
  const isMobile = window.innerWidth <= 768;
  SCENE_PRESETS = (isMobile ? SCENE_DEFAULTS_MOBILE : SCENE_DEFAULTS_DESKTOP)
    .map(p => JSON.parse(JSON.stringify(p)));
  applyState(SCENE_PRESETS[0], true);
}


// ── FUNÇÕES DE PRESET ─────────────────────────────────────────────────────────

// Captura o estado atual de todos os parâmetros em um objeto
function captureState() {
  return {
    FIELD_SCALE, FIELD_ANGLE, FIELD_EVOLUTION,
    REPULSION_RADIUS, REPULSION_STRENGTH,
    NUM_PARTICLES, TRAIL_LENGTH, MIN_WIDTH, MAX_WIDTH, SPEED, WRAP_EDGES,
    ATTRACTOR_RADIUS, ATTRACTOR_STRENGTH, ATTRACTOR_DECAY, ORBIT_DISTANCE,
    FADE_TAIL, BG_FADE, BG_FADE_ALPHA, SAT_MULT, LIGHT_MULT,
    BG_COLOR: [...BG_COLOR],
    PALETTE:  PALETTE.map(c => [...c]),
    SPHERE_R_PCT, SPHERE_R_MIN, SPHERE_R_MAX, ROT_SPEED,
  };
}

// Aplica um objeto de estado aos parâmetros globais
// doInit = true → reinicia as partículas após aplicar
function applyState(s, doInit) {
  FIELD_SCALE        = s.FIELD_SCALE;
  FIELD_ANGLE        = s.FIELD_ANGLE;
  FIELD_EVOLUTION    = s.FIELD_EVOLUTION;
  REPULSION_RADIUS   = s.REPULSION_RADIUS;
  REPULSION_STRENGTH = s.REPULSION_STRENGTH;
  NUM_PARTICLES      = s.NUM_PARTICLES;
  TRAIL_LENGTH       = s.TRAIL_LENGTH;
  MIN_WIDTH          = s.MIN_WIDTH;
  MAX_WIDTH          = s.MAX_WIDTH;
  SPEED              = s.SPEED;
  WRAP_EDGES         = s.WRAP_EDGES;
  ATTRACTOR_RADIUS   = s.ATTRACTOR_RADIUS;
  ATTRACTOR_STRENGTH = s.ATTRACTOR_STRENGTH;
  ATTRACTOR_DECAY    = s.ATTRACTOR_DECAY;
  ORBIT_DISTANCE     = s.ORBIT_DISTANCE;
  FADE_TAIL          = s.FADE_TAIL;
  BG_FADE            = s.BG_FADE;
  BG_FADE_ALPHA      = s.BG_FADE_ALPHA;
  SAT_MULT           = s.SAT_MULT;
  LIGHT_MULT         = s.LIGHT_MULT;
  BG_COLOR           = [...s.BG_COLOR];
  PALETTE            = s.PALETTE.map(c => [...c]);
  SPHERE_R_PCT       = s.SPHERE_R_PCT;
  SPHERE_R_MIN       = s.SPHERE_R_MIN;
  SPHERE_R_MAX       = s.SPHERE_R_MAX;
  ROT_SPEED          = s.ROT_SPEED;
  SPHERE_R           = calcSphereR();
  if (doInit) init();
}

// Interpolação linear entre dois números
function lerpN(a, b, t) { return a + (b - a) * t; }

// Interpola entre dois estados completos (usado pelo slider)
function lerpState(a, b, t) {
  return {
    FIELD_SCALE:        lerpN(a.FIELD_SCALE,        b.FIELD_SCALE,        t),
    FIELD_ANGLE:        lerpN(a.FIELD_ANGLE,        b.FIELD_ANGLE,        t),
    FIELD_EVOLUTION:    lerpN(a.FIELD_EVOLUTION,    b.FIELD_EVOLUTION,    t),
    REPULSION_RADIUS:   lerpN(a.REPULSION_RADIUS,   b.REPULSION_RADIUS,   t),
    REPULSION_STRENGTH: lerpN(a.REPULSION_STRENGTH, b.REPULSION_STRENGTH, t),
    NUM_PARTICLES:      Math.round(lerpN(a.NUM_PARTICLES, b.NUM_PARTICLES, t)),
    TRAIL_LENGTH:       Math.round(lerpN(a.TRAIL_LENGTH,  b.TRAIL_LENGTH,  t)),
    MIN_WIDTH:          lerpN(a.MIN_WIDTH,          b.MIN_WIDTH,          t),
    MAX_WIDTH:          lerpN(a.MAX_WIDTH,          b.MAX_WIDTH,          t),
    SPEED:              lerpN(a.SPEED,              b.SPEED,              t),
    WRAP_EDGES:         t < 0.5 ? a.WRAP_EDGES : b.WRAP_EDGES,
    ATTRACTOR_RADIUS:   lerpN(a.ATTRACTOR_RADIUS,   b.ATTRACTOR_RADIUS,   t),
    ATTRACTOR_STRENGTH: lerpN(a.ATTRACTOR_STRENGTH, b.ATTRACTOR_STRENGTH, t),
    ATTRACTOR_DECAY:    lerpN(a.ATTRACTOR_DECAY,    b.ATTRACTOR_DECAY,    t),
    ORBIT_DISTANCE:     lerpN(a.ORBIT_DISTANCE,     b.ORBIT_DISTANCE,     t),
    FADE_TAIL:          t < 0.5 ? a.FADE_TAIL : b.FADE_TAIL,
    BG_FADE:            t < 0.5 ? a.BG_FADE   : b.BG_FADE,
    BG_FADE_ALPHA:      lerpN(a.BG_FADE_ALPHA,      b.BG_FADE_ALPHA,      t),
    SAT_MULT:           lerpN(a.SAT_MULT,           b.SAT_MULT,           t),
    LIGHT_MULT:         lerpN(a.LIGHT_MULT,         b.LIGHT_MULT,         t),
    BG_COLOR:           a.BG_COLOR.map((v, i) => Math.round(lerpN(v, b.BG_COLOR[i], t))),
    PALETTE:            a.PALETTE.map((c, i) => c.map((v, j) =>
                          j < 3 ? Math.round(lerpN(v, b.PALETTE[i][j], t))
                                :          lerpN(v, b.PALETTE[i][j], t)
                        )),
    SPHERE_R_PCT:       lerpN(a.SPHERE_R_PCT, b.SPHERE_R_PCT, t),
    SPHERE_R_MIN:       lerpN(a.SPHERE_R_MIN, b.SPHERE_R_MIN, t),
    SPHERE_R_MAX:       lerpN(a.SPHERE_R_MAX, b.SPHERE_R_MAX, t),
    ROT_SPEED:          lerpN(a.ROT_SPEED,    b.ROT_SPEED,    t),
  };
}

// Aplica o estado correspondente a uma posição contínua no slider (0.0 – 4.0)
// Posições entre inteiros interpolam entre os dois presets vizinhos
function applyScenePos(pos, doInit) {
  const i = Math.floor(pos);
  const t = pos - i;
  const a = SCENE_PRESETS[Math.min(i,     4)];
  const b = SCENE_PRESETS[Math.min(i + 1, 4)];
  if (i >= 4 || t === 0) {
    applyState(a, doInit);
  } else {
    applyState(lerpState(a, b, t), doInit);
  }
}


// ── SETUP E DRAW (p5.js) ──────────────────────────────────────────────────────

// Envia o tema (light/dark) para o iframe pai via postMessage
// O Webflow usa isso para adaptar cores de texto sobre o canvas
function emitTheme() {
  const lum   = 0.299 * BG_COLOR[0] + 0.587 * BG_COLOR[1] + 0.114 * BG_COLOR[2];
  const theme = lum > 128 ? 'light' : 'dark';
  try { window.parent.postMessage({ fidenzaTheme: theme }, '*'); } catch (e) {}
}

function setup() {
  CANVAS_W = window.innerWidth;
  CANVAS_H = window.innerHeight;
  SPHERE_R = calcSphereR();

  // Aplica preset 0 sem reiniciar partículas (init() será chamado pelo setTimeout abaixo)
  applyState(SCENE_PRESETS[0], false);

  // Cria o canvas p5 e posiciona sobre o body
  const cnv = createCanvas(CANVAS_W, CANVAS_H);
  cnv.elt.style.cssText = 'display:block; position:absolute; top:0; left:0; pointer-events:none;';

  // Atualiza o atrator ao mover o mouse
  document.addEventListener('mousemove', function (e) {
    const r          = cnv.elt.getBoundingClientRect();
    attractor.x      = e.clientX - r.left;
    attractor.y      = e.clientY - r.top;
    attractor.strength = 1.0;
    attractor.active = true;
  });

  // Painel de edição (apenas em modo ?edit=true)
  if (EDIT_MODE) buildEditUI();

  // Slider de cenas para o usuário
  buildUserSlider();
  if (window._updateSliderTheme) window._updateSliderTheme();

  // Aguarda 200ms para garantir dimensões corretas (necessário em mobile/iframe)
  setTimeout(function () {
    CANVAS_W = window.innerWidth;
    CANVAS_H = window.innerHeight;
    SPHERE_R = calcSphereR();
    resizeCanvas(CANVAS_W, CANVAS_H);
    _chooseAndApplyPresets();
  }, 200);

  // Escuta o sinal da intro (window._introSignal = true)
  // Quando recebe, libera a animação do slider
  window._introSignalReceived = false;
  const _signalPoller = setInterval(function () {
    if (window._introSignal) {
      window._introSignalReceived = true;
      clearInterval(_signalPoller);
      if (window._startSliderHint) window._startSliderHint();
    }
  }, 50);

  emitTheme();

  // Redimensiona e reaplica presets quando o container muda de tamanho
  new ResizeObserver(function (entries) {
    for (const e of entries) {
      const nw = Math.floor(e.contentRect.width);
      const nh = Math.floor(e.contentRect.height);
      if (nw > 0 && nh > 0 && (nw !== CANVAS_W || nh !== CANVAS_H)) {
        CANVAS_W = nw; CANVAS_H = nh;
        SPHERE_R = calcSphereR();
        resizeCanvas(CANVAS_W, CANVAS_H);
        _chooseAndApplyPresets();
      }
    }
  }).observe(document.body);
}

// Correção de dimensões no primeiro frame (necessário em alguns browsers)
let _firstFrame = true;

function draw() {
  // Garante dimensões corretas no primeiro frame
  if (_firstFrame) {
    const nw = Math.floor(window.innerWidth);
    const nh = Math.floor(window.innerHeight);
    if (nw > 0 && nh > 0 && (nw !== CANVAS_W || nh !== CANVAS_H)) {
      CANVAS_W = nw; CANVAS_H = nh;
      SPHERE_R = calcSphereR();
      resizeCanvas(CANVAS_W, CANVAS_H);
      _chooseAndApplyPresets();
    }
    _firstFrame = false;
  }

  // Fundo: ou limpo (sólido) ou semi-transparente (cria rastro nas partículas)
  if (BG_FADE) {
    fill(BG_COLOR[0], BG_COLOR[1], BG_COLOR[2], BG_FADE_ALPHA);
    noStroke();
    rect(0, 0, width, height);
  } else {
    background(BG_COLOR[0], BG_COLOR[1], BG_COLOR[2]);
  }

  // Decai a força do atrator a cada frame (simula inércia do mouse)
  if (attractor.strength > 0) {
    attractor.strength = max(0, attractor.strength - ATTRACTOR_DECAY);
    if (attractor.strength === 0) attractor.active = false;
  }

  // Rotação automática da esfera
  rotY += ROT_SPEED;

  // Atualiza grid espacial e desenha partículas
  buildSpatialGrid();
  for (const p of particles) {
    p.update();
    p.draw();
  }
}

// Reinicia todas as partículas com nova seed aleatória (ou fixa)
function init() {
  const s = USE_FIXED_SEED ? FIXED_SEED : floor(random(999999));
  randomSeed(s);
  noiseSeed(s);
  particles = [];
  for (let i = 0; i < NUM_PARTICLES; i++) {
    particles.push(new Particle());
  }
}

// Reconstrói o grid espacial para otimizar lookup de vizinhos na repulsão
// Cada célula agrupa partículas próximas — evita comparar todas com todas (O(n²))
function buildSpatialGrid() {
  spatialGrid.cell  = max(1, REPULSION_RADIUS);
  spatialGrid.cells = {};
  for (const p of particles) {
    const cx = floor(p.x / spatialGrid.cell);
    const cy = floor(p.y / spatialGrid.cell);
    const k  = cx + ',' + cy;
    if (!spatialGrid.cells[k]) spatialGrid.cells[k] = [];
    spatialGrid.cells[k].push(p);
  }
}

// Retorna o ângulo do flow field para o ponto (x, y) no frame atual
function fieldAngle(x, y) {
  return noise(x * FIELD_SCALE, y * FIELD_SCALE, frameCount * FIELD_EVOLUTION) * FIELD_ANGLE;
}

// Callback do p5.js chamado automaticamente ao redimensionar a janela
function windowResized() {
  CANVAS_W = document.body.clientWidth  || window.innerWidth;
  CANVAS_H = document.body.clientHeight || window.innerHeight;
  resizeCanvas(CANVAS_W, CANVAS_H);
  _chooseAndApplyPresets();
}


// ── CLASSE PARTICLE ───────────────────────────────────────────────────────────
class Particle {
  constructor() {
    this.x       = random(CANVAS_W);
    this.y       = random(CANVAS_H);
    this.wNorm   = random(); // normalizado [0,1] → interpola entre MIN_WIDTH e MAX_WIDTH
    this.colNorm = random(); // normalizado [0,1] → seleciona cor da paleta
    this.trail   = [];
    this.vel     = { x: 0, y: 0 };
  }

  update() {
    // Grava posição atual no trail
    this.trail.push({ x: this.x, y: this.y });
    while (this.trail.length > TRAIL_LENGTH) this.trail.shift();

    // Direção base do flow field
    const fa = fieldAngle(this.x, this.y);
    let fx = cos(fa);
    let fy = sin(fa);

    // Influência do atrator (mouse)
    if (attractor.active && attractor.strength > 0) {
      // Compara usando posição projetada na esfera (não posição 2D bruta)
      const proj = toSphere(this.x, this.y);
      const dx   = attractor.x - proj.px;
      const dy   = attractor.y - proj.py;
      const d    = sqrt(dx * dx + dy * dy);

      if (d < ATTRACTOR_RADIUS) {
        const inf = (1 - d / ATTRACTOR_RADIUS) * attractor.strength;
        if (d > 0.1) {
          const rf = (d - ORBIT_DISTANCE) / ATTRACTOR_RADIUS;
          const nx = dx / d, ny = dy / d; // normal (aponta para o atrator)
          const tx = -ny,    ty = nx;     // tangente (perpendicular)
          // Combina atração radial com componente orbital tangencial
          const ax = (nx * rf + tx * 0.8) * inf * ATTRACTOR_STRENGTH;
          const ay = (ny * rf + ty * 0.8) * inf * ATTRACTOR_STRENGTH;
          fx = lerp(fx, ax, inf);
          fy = lerp(fy, ay, inf);
        }
      }
    }

    // Repulsão entre partículas vizinhas (usa grid espacial)
    if (REPULSION_STRENGTH > 0) {
      let rx = 0, ry = 0;
      const cx = floor(this.x / spatialGrid.cell);
      const cy = floor(this.y / spatialGrid.cell);

      // Verifica as 9 células ao redor
      for (let ddx = -1; ddx <= 1; ddx++) {
        for (let ddy = -1; ddy <= 1; ddy++) {
          const nb = spatialGrid.cells[(cx + ddx) + ',' + (cy + ddy)];
          if (!nb) continue;
          for (const o of nb) {
            if (o === this) continue;
            const ox = this.x - o.x;
            const oy = this.y - o.y;
            const od = sqrt(ox * ox + oy * oy);
            if (od > 0 && od < REPULSION_RADIUS) {
              const f = (1 - od / REPULSION_RADIUS) * REPULSION_STRENGTH;
              rx += ox / od * f;
              ry += oy / od * f;
            }
          }
        }
      }
      fx += rx;
      fy += ry;
    }

    // Aplica força ao velocity com inércia (lerp)
    this.vel.x = lerp(this.vel.x, fx * SPEED, 0.25);
    this.vel.y = lerp(this.vel.y, fy * SPEED, 0.25);
    this.x    += this.vel.x;
    this.y    += this.vel.y;

    // Wrapping: ao sair de um lado, aparece no lado oposto
    // O trail é corrigido para não criar artefatos visuais no wraparound
    if (WRAP_EDGES) {
      let ox = 0, oy = 0;
      if (this.x < 0)        { ox =  CANVAS_W; this.x += CANVAS_W; }
      if (this.x > CANVAS_W) { ox = -CANVAS_W; this.x -= CANVAS_W; }
      if (this.y < 0)        { oy =  CANVAS_H; this.y += CANVAS_H; }
      if (this.y > CANVAS_H) { oy = -CANVAS_H; this.y -= CANVAS_H; }
      if (ox || oy) {
        for (const pt of this.trail) { pt.x += ox; pt.y += oy; }
      }
    } else {
      this.x = constrain(this.x, 0, CANVAS_W);
      this.y = constrain(this.y, 0, CANVAS_H);
    }
  }

  draw() {
    if (this.trail.length < 2) return;

    // Projeta o trail completo na superfície da esfera
    const pts      = this.trail.map(p => toSphere(p.x, p.y));
    const avgDepth = pts.reduce((s, p) => s + p.depth, 0) / pts.length;

    // Partículas mais "fundo" (depth ≈ -1) ficam mais transparentes
    const alpha = map(avgDepth, -1, 1, 0.06, 1.0);
    const col   = pickColorFromNorm(this.colNorm);
    const [r, g, b] = col;

    // Constrói ribbon (faixa) ao redor do trail usando perpendiculares
    const left  = [];
    const right = [];
    const n     = pts.length;

    for (let i = 0; i < n; i++) {
      // Ângulo tangente ao trail no ponto i
      const a = i < n - 1
        ? atan2(pts[i+1].py - pts[i].py, pts[i+1].px - pts[i].px)
        : atan2(pts[i].py   - pts[i-1].py, pts[i].px   - pts[i-1].px);

      const perp = a + 1.5708; // perpendicular (90°)
      const t    = FADE_TAIL ? i / (n - 1) : 1; // afunila a ponta se FADE_TAIL
      const hw   = lerp(MIN_WIDTH, MAX_WIDTH, this.wNorm) * t / 2; // meia-largura

      left.push ({ x: pts[i].px + cos(perp) * hw, y: pts[i].py + sin(perp) * hw });
      right.push({ x: pts[i].px - cos(perp) * hw, y: pts[i].py - sin(perp) * hw });
    }

    noStroke();
    fill(r, g, b, 255 * alpha);
    beginShape();
    for (const p of left)          curveVertex(p.x, p.y);
    for (const p of right.reverse()) curveVertex(p.x, p.y);
    endShape(CLOSE);
  }
}


// ── UTILITÁRIOS DE COR ────────────────────────────────────────────────────────

// Seleciona uma cor da paleta baseado num valor normalizado [0,1]
// usando as probabilidades de cada cor como pesos
function pickColorFromNorm(norm) {
  const total = PALETTE.reduce((s, c) => s + c[3], 0);
  let acc = 0;
  for (const c of PALETTE) {
    acc += c[3] / total;
    if (norm <= acc) return applyColorMods(c);
  }
  return applyColorMods(PALETTE[PALETTE.length - 1]);
}

// Aplica os modificadores de saturação e luminosidade à cor
// Converte RGB → HSL → modifica S e L → converte de volta para RGB
function applyColorMods(c) {
  let r = c[0]/255, g = c[1]/255, b = c[2]/255;
  const mx = Math.max(r,g,b), mn = Math.min(r,g,b), d = mx - mn;
  let h = 0, s = 0, l = (mx + mn) / 2;

  if (d > 0) {
    s = d / (1 - Math.abs(2 * l - 1));
    if      (mx === r) h = ((g - b) / d + 6) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else               h = (r - g) / d + 4;
    h /= 6;
  }

  s = Math.min(1, s * SAT_MULT);
  l = Math.min(1, Math.max(0, l * LIGHT_MULT));

  const q  = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p2 = 2 * l - q;

  function hue(t) {
    t = (t + 1) % 1;
    if (t < 1/6) return p2 + (q - p2) * 6 * t;
    if (t < 1/2) return q;
    if (t < 2/3) return p2 + (q - p2) * (2/3 - t) * 6;
    return p2;
  }

  return [
    Math.round(hue(h + 1/3) * 255),
    Math.round(hue(h)       * 255),
    Math.round(hue(h - 1/3) * 255),
    c[3],
  ];
}

// Converte RGB para hex string (#rrggbb)
function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
}

// Converte hex string para objeto {r, g, b}
function hexToRgb(h) {
  return {
    r: parseInt(h.slice(1, 3), 16),
    g: parseInt(h.slice(3, 5), 16),
    b: parseInt(h.slice(5, 7), 16),
  };
}


// ── SLIDER DO USUÁRIO ─────────────────────────────────────────────────────────
/*
  Slider horizontal flutuante que permite ao usuário navegar entre os 5 presets.
  Inclui uma animação de hint (playHint) que demonstra o movimento ao carregar.
  O hint só inicia após receber window._introSignal (sinal da intro).
*/
function buildUserSlider() {
  const SLIDER_W          = Math.min(440, Math.max(330, window.innerWidth * 0.31));
  const SLIDER_H          = 54;
  const PADDING_X         = 38;
  const WRAP_TOP          = window.innerHeight * 0.18;
  const THUMB_ACTIVE_COLOR = '#e8fe41';

  // Duração das animações do hint
  const HINT_FORWARD_MS     = 3000; // tempo para ir do ponto 0 ao 3
  const HINT_BACK_MS        = 1000; // tempo para voltar do 3 ao 0
  const HINT_START_DELAY_MS = 700;  // pausa antes de iniciar
  const HINT_MIDDLE_DELAY_MS = 600; // pausa no ponto 3 antes de voltar

  // ── CSS do slider ──
  const style = document.createElement('style');
  style.textContent = `
    #usr-wrap {
      position: fixed;
      left: 50%;
      top: ${WRAP_TOP}px;
      transform: translateX(-50%);
      width: ${SLIDER_W}px;
      height: ${SLIDER_H}px;
      z-index: 300;
      pointer-events: auto;
      touch-action: pan-x;
      user-select: none;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    #usr-arc {
      position: relative;
      width: ${SLIDER_W}px;
      height: ${SLIDER_H}px;
      overflow: visible;
      cursor: pointer;
      border-radius: 999px;
      background: var(--s-panel-bg, rgba(255,255,255,0.08));
      border: 1px solid var(--s-panel-stroke, rgba(255,255,255,0.14));
      box-shadow: 0 10px 30px rgba(0,0,0,0.16), inset 0 1px 0 rgba(255,255,255,0.05);
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
    }
    /* Borda tracejada interna */
    #usr-arc::before {
      content: "";
      position: absolute;
      inset: 10px 18px;
      border-radius: 999px;
      border: 1px dashed var(--s-dash, rgba(255,255,255,0.18));
      opacity: .65;
      pointer-events: none;
    }
    /* Bolhas decorativas */
    #usr-arc::after {
      content: "";
      position: absolute;
      inset: 18px 60px;
      border-radius: 999px;
      background:
        radial-gradient(circle at 28% 50%, var(--s-bubble-1, rgba(255,255,255,0.07)) 0 34px, transparent 35px),
        radial-gradient(circle at 50% 50%, var(--s-bubble-2, rgba(255,255,255,0.05)) 0 52px, transparent 53px),
        radial-gradient(circle at 72% 50%, var(--s-bubble-3, rgba(255,255,255,0.06)) 0 30px, transparent 31px);
      filter: blur(5px);
      opacity: .95;
      pointer-events: none;
    }
    #usr-arc svg { width:100%; height:100%; display:block; overflow:visible; position:relative; z-index:2; }
    #usr-arc .track-bg   { fill:none; stroke:var(--s-line,rgba(255,255,255,0.28)); stroke-width:1.55; }
    #usr-arc .track-fill { fill:none; stroke:var(--s-fill,rgba(255,255,255,0.95)); stroke-width:2.6; stroke-linecap:round; transition:stroke .35s ease; }
    #usr-arc .tick-dot   { fill:var(--s-dot,rgba(255,255,255,0.34)); transition:fill .25s ease, r .25s ease, opacity .25s ease; opacity:.95; }
    #usr-arc .tick-dot.active { fill:var(--s-dot-active,rgba(255,255,255,1)); }
    #usr-arc .thumb-ring,
    #usr-arc .thumb {
      transform-box: fill-box;
      transform-origin: center;
      transition: transform .34s cubic-bezier(.22,.8,.22,1), fill .34s ease, stroke .34s ease;
    }
    #usr-arc .thumb-ring { fill:none; stroke:var(--s-thumb-ring,rgba(255,255,255,0.35)); stroke-width:1.2; }
    #usr-arc .thumb      { fill:var(--s-thumb,#fff); filter:drop-shadow(0 2px 8px rgba(0,0,0,0.22)); }
    #usr-arc .thumb.moving      { fill:var(--s-thumb-active,#E6FF3F); transform:scale(1.72); }
    #usr-arc .thumb-ring.moving { stroke:var(--s-thumb-ring-active,rgba(230,255,63,0.45)); transform:scale(1.42); }
    @media (max-width: 900px) {
      #usr-wrap { left:50%; top:108px; transform:translateX(-50%) scale(.92); transform-origin:center top; }
    }
    @media (max-width: 640px) {
      #usr-wrap { width:min(92vw,360px); transform:translateX(-50%) scale(.88); }
      #usr-arc  { height:70px; }
    }
  `;
  document.head.appendChild(style);

  // ── DOM do slider ──
  const wrap = document.createElement('div');
  wrap.id    = 'usr-wrap';
  document.body.appendChild(wrap);

  const arc = document.createElement('div');
  arc.id    = 'usr-arc';
  wrap.appendChild(arc);

  const TRACK_START_X = PADDING_X;
  const TRACK_END_X   = SLIDER_W - PADDING_X;
  const TRACK_Y       = SLIDER_H / 2 + 1;
  const TRACK_W       = TRACK_END_X - TRACK_START_X;

  arc.innerHTML = `
    <svg viewBox="0 0 ${SLIDER_W} ${SLIDER_H}" aria-hidden="true">
      <line class="track-bg"   x1="${TRACK_START_X}" y1="${TRACK_Y}" x2="${TRACK_END_X}"   y2="${TRACK_Y}"></line>
      <line class="track-fill" x1="${TRACK_START_X}" y1="${TRACK_Y}" x2="${TRACK_START_X}" y2="${TRACK_Y}"></line>
      <g class="track-points"></g>
      <circle class="thumb-ring" cx="${TRACK_START_X}" cy="${TRACK_Y}" r="10"></circle>
      <circle class="thumb"      cx="${TRACK_START_X}" cy="${TRACK_Y}" r="4.6"></circle>
    </svg>
  `;

  const fillLine    = arc.querySelector('.track-fill');
  const pointsGroup = arc.querySelector('.track-points');
  const thumb       = arc.querySelector('.thumb');
  const thumbRing   = arc.querySelector('.thumb-ring');
  const dotEls      = [];

  // Cria os 5 pontos de toque no track (um por preset)
  for (let i = 0; i < 5; i++) {
    const pt  = pointOnTrack(i / 4);
    const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    dot.setAttribute('class', 'tick-dot');
    dot.setAttribute('cx', pt.x);
    dot.setAttribute('cy', pt.y);
    dot.setAttribute('r', 3.4);
    pointsGroup.appendChild(dot);
    dotEls.push(dot);
  }

  // Converte fração [0,1] para coordenada no track
  function pointOnTrack(t) {
    return { x: TRACK_START_X + TRACK_W * t, y: TRACK_Y };
  }

  // Converte posição X do cliente para valor do slider [0,4]
  function clientToValue(clientX) {
    const rect = arc.getBoundingClientRect();
    const x    = clientX - rect.left;
    const t    = Math.max(0, Math.min(1, (x - TRACK_START_X) / TRACK_W));
    return t * 4;
  }

  let _dragging    = false;
  let _curVal      = 0;
  let _hintPlaying = true;
  let _hintRAF     = null;

  function setThumbMovingState(isMoving) {
    thumb.classList.toggle('moving', isMoving);
    thumbRing.classList.toggle('moving', isMoving);
  }

  // Atualiza o slider para o valor v e aplica o preset correspondente
  function setVal(v, doInit) {
    _curVal  = Math.max(0, Math.min(4, v));
    SCENE_POS = _curVal;
    const t  = _curVal / 4;
    const pt = pointOnTrack(t);

    thumb.setAttribute('cx', pt.x);
    thumb.setAttribute('cy', pt.y);
    thumbRing.setAttribute('cx', pt.x);
    thumbRing.setAttribute('cy', pt.y);
    setThumbMovingState(_dragging || _hintPlaying);
    fillLine.setAttribute('x2', pt.x);
    fillLine.setAttribute('y2', TRACK_Y);

    dotEls.forEach((d, i) => {
      const active = Math.abs(_curVal - i) < 0.16;
      d.classList.toggle('active', active);
      d.setAttribute('r', active ? 5.8 : 3.4);
    });

    applyScenePos(_curVal, doInit || false);
    if (window._refreshAllSliders) window._refreshAllSliders();
    if (window._updateSliderTheme) window._updateSliderTheme(_dragging);
  }

  function stopHint() {
    _hintPlaying = false;
    if (_hintRAF) cancelAnimationFrame(_hintRAF);
    _hintRAF = null;
    setThumbMovingState(false);
  }

  function easeInOut(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }

  // Anima o thumb entre dois valores durante dur ms, chama done() ao terminar
  function animateBetween(from, to, dur, done) {
    const start = performance.now();
    function frame(now) {
      if (!_hintPlaying) return;
      const p = Math.min(1, (now - start) / dur);
      setVal(from + (to - from) * easeInOut(p), false);
      if (p < 1) {
        _hintRAF = requestAnimationFrame(frame);
      } else {
        done && done();
      }
    }
    _hintRAF = requestAnimationFrame(frame);
  }

  // Animação de hint: vai de 0 → 3, pausa, volta para 0
  // Executada automaticamente ao carregar para mostrar a funcionalidade ao usuário
  function playHint() {
    setVal(0, false);
    setTimeout(() => {
      if (!_hintPlaying) return;
      animateBetween(0, 3, HINT_FORWARD_MS, () => {
        if (!_hintPlaying) return;
        setTimeout(() => {
          if (!_hintPlaying) return;
          animateBetween(3, 0, HINT_BACK_MS, () => {
            _hintPlaying = false;
            _hintRAF     = null;
            setVal(0, false);
            setThumbMovingState(false);
          });
        }, HINT_MIDDLE_DELAY_MS);
      });
    }, HINT_START_DELAY_MS);
  }

  // ── Interação por pointer (mouse e touch) ──
  arc.addEventListener('pointerdown', e => {
    stopHint();
    _dragging = true;
    setThumbMovingState(true);
    arc.setPointerCapture(e.pointerId);
    // Snap para o preset mais próximo se clicar perto de um ponto
    const hitIndex = findNearestPreset(e.clientX, e.clientY);
    setVal(hitIndex !== null ? hitIndex : clientToValue(e.clientX));
    e.preventDefault();
  });

  arc.addEventListener('pointermove', e => {
    if (!_dragging) return;
    setVal(clientToValue(e.clientX));
  });

  function endDrag(e) {
    _dragging = false;
    if (e && arc.hasPointerCapture && arc.hasPointerCapture(e.pointerId)) {
      arc.releasePointerCapture(e.pointerId);
    }
    setVal(_curVal, false);
    setTimeout(() => {
      if (!_dragging && !_hintPlaying) setThumbMovingState(false);
    }, 20);
  }

  arc.addEventListener('pointerup',           endDrag);
  arc.addEventListener('pointercancel',        endDrag);
  arc.addEventListener('lostpointercapture', () => {
    _dragging = false;
    setTimeout(() => {
      if (!_dragging && !_hintPlaying) setThumbMovingState(false);
    }, 20);
  });

  // Encontra o preset mais próximo do clique (para snap ao clicar nos dots)
  function findNearestPreset(clientX, clientY) {
    const rect = arc.getBoundingClientRect();
    const x    = clientX - rect.left;
    const y    = clientY - rect.top;
    for (let i = 0; i < 5; i++) {
      const pt      = pointOnTrack(i / 4);
      const labelY  = TRACK_Y - 18;
      const dLabel  = (x - pt.x) ** 2 + (y - labelY) ** 2;
      if (dLabel < 30 * 30) return i;
      const dDot    = (x - pt.x) ** 2 + (y - pt.y) ** 2;
      if (dDot   < 24 * 24) return i;
    }
    return null;
  }

  // ── Tema do slider (light/dark) ──
  // Adapta as cores do slider baseado na luminosidade do fundo atual
  let _lastTheme = '';
  window._updateSliderTheme = function (force) {
    const lum   = 0.299 * BG_COLOR[0] + 0.587 * BG_COLOR[1] + 0.114 * BG_COLOR[2];
    const theme = lum > 128 ? 'light' : 'dark';
    if (!force && theme === _lastTheme) return;
    _lastTheme = theme;
    const r = document.documentElement;

    if (theme === 'light') {
      r.style.setProperty('--s-panel-bg',           'rgba(255,255,255,0.58)');
      r.style.setProperty('--s-panel-stroke',        'rgba(0,0,0,0.08)');
      r.style.setProperty('--s-dash',                'rgba(0,0,0,0.14)');
      r.style.setProperty('--s-bubble-1',            'rgba(0,0,0,0.035)');
      r.style.setProperty('--s-bubble-2',            'rgba(0,0,0,0.025)');
      r.style.setProperty('--s-bubble-3',            'rgba(0,0,0,0.03)');
      r.style.setProperty('--s-line',                'rgba(0,0,0,0.14)');
      r.style.setProperty('--s-fill',                'rgba(0,0,0,0.48)');
      r.style.setProperty('--s-dot',                 'rgba(0,0,0,0.28)');
      r.style.setProperty('--s-dot-active',          'rgba(0,0,0,0.9)');
      r.style.setProperty('--s-thumb',               '#111');
      r.style.setProperty('--s-thumb-ring',          'rgba(0,0,0,0.18)');
      r.style.setProperty('--s-thumb-active',        THUMB_ACTIVE_COLOR);
      r.style.setProperty('--s-thumb-ring-active',   'rgba(230,255,63,0.52)');
      r.style.setProperty('--s-label',               'rgba(0,0,0,0.55)');
      r.style.setProperty('--s-label-active',        'rgba(0,0,0,0.96)');
    } else {
      r.style.setProperty('--s-panel-bg',            'rgba(28,28,42,0.34)');
      r.style.setProperty('--s-panel-stroke',        'rgba(255,255,255,0.10)');
      r.style.setProperty('--s-dash',                'rgba(255,255,255,0.16)');
      r.style.setProperty('--s-bubble-1',            'rgba(255,255,255,0.05)');
      r.style.setProperty('--s-bubble-2',            'rgba(255,255,255,0.04)');
      r.style.setProperty('--s-bubble-3',            'rgba(255,255,255,0.045)');
      r.style.setProperty('--s-line',                'rgba(255,255,255,0.18)');
      r.style.setProperty('--s-fill',                'rgba(255,255,255,0.92)');
      r.style.setProperty('--s-dot',                 'rgba(255,255,255,0.34)');
      r.style.setProperty('--s-dot-active',          'rgba(255,255,255,1)');
      r.style.setProperty('--s-thumb',               '#fff');
      r.style.setProperty('--s-thumb-ring',          'rgba(255,255,255,0.30)');
      r.style.setProperty('--s-thumb-active',        THUMB_ACTIVE_COLOR);
      r.style.setProperty('--s-thumb-ring-active',   'rgba(230,255,63,0.52)');
      r.style.setProperty('--s-label',               'rgba(255,255,255,0.76)');
      r.style.setProperty('--s-label-active',        'rgba(255,255,255,1)');
    }

    try { window.parent.postMessage({ fidenzaTheme: theme }, '*'); } catch (e) {}
  };

  // Atualiza o tema a cada 500ms (para quando a cor de fundo mudar via preset)
  setInterval(() => {
    if (!_dragging && window._updateSliderTheme) window._updateSliderTheme();
  }, 500);

  // Posiciona o thumb no início e aguarda o sinal da intro para animar
  setVal(0, false);
  if (window._introSignalReceived) {
    // Intro já terminou antes do slider ser construído (caso improvável)
    playHint();
  } else {
    // Registra callback — será chamado quando _introSignal chegar
    window._startSliderHint = function () { playHint(); };
  }
}


// ── PAINEL DE EDIÇÃO (?edit=true) ─────────────────────────────────────────────
/*
  Painel lateral com controles para todos os parâmetros da simulação.
  Acessível apenas via URL com ?edit=true.
  Permite ajustar e salvar presets, depois exportar o JSON para colar
  nos arrays SCENE_DEFAULTS_DESKTOP e SCENE_DEFAULTS_MOBILE acima.
*/
function buildEditUI() {
  const style = document.createElement('style');
  style.textContent = `
    #toggle-btn {
      position:fixed; left:10px; top:50%; transform:translateY(-50%);
      z-index:200; background:rgba(30,30,30,0.85); color:#eee;
      border:1px solid #555; padding:6px 12px; cursor:pointer;
      font-family:monospace; font-size:12px; border-radius:4px;
      backdrop-filter:blur(4px); writing-mode:vertical-rl;
      letter-spacing:2px; pointer-events:auto; touch-action:manipulation;
    }
    #toggle-btn:hover { background:rgba(60,60,60,0.95); }
    #ui-sidebar {
      position:fixed; left:0; top:50%; transform:translateY(-50%);
      z-index:199; width:0; max-height:90vh; overflow:hidden;
      transition:width 0.2s ease; background:rgba(20,20,20,0.92);
      border-right:1px solid #444; backdrop-filter:blur(8px);
      border-radius:0 8px 8px 0; pointer-events:auto; touch-action:auto;
    }
    #ui-sidebar.open { width:270px; }
    #ui-panel {
      display:flex; flex-direction:column; gap:6px;
      padding:16px 12px; min-width:260px; max-height:90vh; overflow-y:auto;
    }
    .sec  { color:#aaa; font-size:10px; letter-spacing:2px; text-transform:uppercase; border-bottom:1px solid #444; padding-bottom:3px; margin-top:6px; }
    .ctrl { display:flex; flex-direction:column; gap:2px; }
    .ctrl label { color:#ccc; font-size:11px; display:flex; justify-content:space-between; }
    .ctrl label span { color:#f0a040; min-width:36px; text-align:right; }
    .ctrl input[type=range] { width:100%; accent-color:#f0a040; cursor:pointer; }
    .ctrl select, .ctrl input[type=checkbox] { background:#333; color:#eee; border:1px solid #555; padding:2px 4px; font-family:monospace; font-size:11px; cursor:pointer; }
    .btn-row { display:flex; gap:8px; margin-top:4px; }
    .btn-row button { flex:1; padding:6px; background:#333; color:#eee; border:1px solid #555; cursor:pointer; font-family:monospace; font-size:12px; border-radius:3px; }
    .btn-row button:hover { background:#f0a040; color:#111; }
    .save-grid { display:grid; grid-template-columns:repeat(5,1fr); gap:4px; margin-top:4px; }
    .save-btn  { padding:5px 2px; background:#2a2a2a; color:#888; border:1px solid #444; cursor:pointer; font-family:monospace; font-size:10px; border-radius:3px; text-align:center; }
    .save-btn:hover  { background:#f0a040; color:#111; border-color:#f0a040; }
    .save-btn.saved  { color:#f0a040; border-color:#f0a040; }
    #export-btn { width:100%; padding:7px; margin-top:6px; background:#1a3a1a; color:#4f4; border:1px solid #4f4; cursor:pointer; font-family:monospace; font-size:11px; border-radius:3px; letter-spacing:1px; }
    #export-btn:hover { background:#4f4; color:#111; }
  `;
  document.head.appendChild(style);

  // Estrutura DOM
  const sidebar = document.createElement('div'); sidebar.id = 'ui-sidebar'; document.body.appendChild(sidebar);
  panel         = document.createElement('div'); panel.id   = 'ui-panel';   sidebar.appendChild(panel);
  const btn     = document.createElement('button'); btn.id  = 'toggle-btn'; btn.textContent = '☰ EDIT';
  btn.onclick   = () => sidebar.classList.toggle('open');
  document.body.appendChild(btn);

  // ── Helpers para criar controles ──

  function sec(t) {
    const d = document.createElement('div'); d.className = 'sec'; d.textContent = t; panel.appendChild(d);
  }

  // Cria um slider com label e valor ao vivo; retorna refs para o input e o span de valor
  function sliderRef(label, get, set, mn, mx, step) {
    const div = document.createElement('div'); div.className = 'ctrl';
    const lbl = document.createElement('label');
    const txt = document.createTextNode(label + ' ');
    const val = document.createElement('span');
    val.textContent = get().toFixed(step < 0.01 ? 4 : step < 1 ? 2 : 0);
    lbl.appendChild(txt); lbl.appendChild(val);
    const inp = document.createElement('input'); inp.type = 'range';
    inp.min   = mn; inp.max = mx; inp.step = step; inp.value = get();
    inp.oninput = () => {
      const v = parseFloat(inp.value);
      set(v);
      val.textContent = v.toFixed(step < 0.01 ? 4 : step < 1 ? 2 : 0);
    };
    div.appendChild(lbl); div.appendChild(inp); panel.appendChild(div);
    return { inp, val };
  }

  function slider(l, g, s, mn, mx, st) { sliderRef(l, g, s, mn, mx, st); }

  function sel(label, opts, get, set) {
    const div = document.createElement('div'); div.className = 'ctrl';
    const lbl = document.createElement('label'); lbl.textContent = label;
    const s   = document.createElement('select');
    opts.forEach(o => {
      const op = document.createElement('option'); op.value = o; op.textContent = o;
      if (o === get()) op.selected = true;
      s.appendChild(op);
    });
    s.onchange = () => set(s.value);
    div.appendChild(lbl); div.appendChild(s); panel.appendChild(div);
  }

  function chk(label, get, set) {
    const div = document.createElement('div'); div.className = 'ctrl';
    const lbl = document.createElement('label'); lbl.textContent = label;
    const inp = document.createElement('input'); inp.type = 'checkbox'; inp.checked = get();
    inp.onchange = () => set(inp.checked);
    div.appendChild(lbl); div.appendChild(inp); panel.appendChild(div);
  }

  // ── Seção de presets ──
  sec('Cenas — salvar preset atual');
  const saveGrid = document.createElement('div'); saveGrid.className = 'save-grid'; panel.appendChild(saveGrid);
  for (let i = 0; i < 5; i++) {
    const sb = document.createElement('button'); sb.className = 'save-btn'; sb.textContent = `P${i + 1}`;
    sb.title   = `Salvar estado atual como preset ${i + 1}`;
    sb.onclick = () => {
      SCENE_PRESETS[i] = captureState();
      sb.classList.add('saved');
      sb.textContent = `P${i + 1} ✓`;
    };
    saveGrid.appendChild(sb);
  }

  // Botão para exportar JSON dos presets atuais
  const expBtn = document.createElement('button'); expBtn.id = 'export-btn'; expBtn.textContent = '📋 Mostrar JSON dos presets';
  expBtn.onclick = () => {
    const json     = JSON.stringify(SCENE_PRESETS, null, 2);
    const existing = document.getElementById('export-textarea');
    if (existing) { existing.parentElement.remove(); return; }
    const wrap = document.createElement('div');
    wrap.style.cssText = 'margin-top:6px; display:flex; flex-direction:column; gap:4px;';
    const ta = document.createElement('textarea'); ta.id = 'export-textarea';
    ta.value     = json;
    ta.style.cssText = 'width:100%; height:180px; background:#0a0a0a; color:#4f4; border:1px solid #4f4; font-family:monospace; font-size:9px; padding:6px; resize:none; border-radius:3px;';
    ta.onclick   = () => ta.select();
    const hint   = document.createElement('div');
    hint.textContent = '👆 Clique na área para selecionar tudo, depois copie';
    hint.style.cssText = 'color:#888; font-size:9px; font-family:monospace; text-align:center;';
    wrap.appendChild(ta); wrap.appendChild(hint);
    expBtn.parentElement.insertBefore(wrap, expBtn.nextSibling);
    ta.select();
  };
  panel.appendChild(expBtn);

  // ── Controles de parâmetros ──
  const _refs = {};

  sec('Esfera');
  _refs.SPHERE_R_PCT = sliderRef('raio %',     () => SPHERE_R_PCT, v => { SPHERE_R_PCT = v; SPHERE_R = calcSphereR(); }, 0.1, 0.8,  0.01);
  _refs.SPHERE_R_MIN = sliderRef('raio min px',() => SPHERE_R_MIN, v => { SPHERE_R_MIN = v; SPHERE_R = calcSphereR(); }, 50,  400,  5);
  _refs.SPHERE_R_MAX = sliderRef('raio max px',() => SPHERE_R_MAX, v => { SPHERE_R_MAX = v; SPHERE_R = calcSphereR(); }, 100, 800,  5);
  _refs.ROT_SPEED    = sliderRef('rotação',    () => ROT_SPEED,    v =>   ROT_SPEED    = v,                              0,   0.02, 0.0001);

  sec('Flow Field');
  _refs.FIELD_SCALE     = sliderRef('field scale',    () => FIELD_SCALE,     v => FIELD_SCALE     = v, 0.0001, 0.008, 0.0001);
  _refs.FIELD_ANGLE     = sliderRef('field angle',    () => FIELD_ANGLE,     v => FIELD_ANGLE     = v, 0.1,    9.0,   0.01);
  _refs.FIELD_EVOLUTION = sliderRef('field evolution',() => FIELD_EVOLUTION, v => FIELD_EVOLUTION = v, 0,      0.01,  0.0001);

  sec('Repulsão');
  _refs.REPULSION_RADIUS   = sliderRef('raio', () => REPULSION_RADIUS,   v => REPULSION_RADIUS   = v, 1, 100, 1);
  _refs.REPULSION_STRENGTH = sliderRef('força',() => REPULSION_STRENGTH, v => REPULSION_STRENGTH = v, 0, 3.0, 0.05);

  sec('Partículas');
  _refs.NUM_PARTICLES = sliderRef('quantidade', () => NUM_PARTICLES, v => { NUM_PARTICLES = Math.round(v); init(); }, 10,  2000, 10);
  _refs.TRAIL_LENGTH  = sliderRef('cauda',      () => TRAIL_LENGTH,  v =>   TRAIL_LENGTH  = Math.round(v),           5,   150,  1);
  _refs.MIN_WIDTH     = sliderRef('min width',  () => MIN_WIDTH,     v =>   MIN_WIDTH     = v,                        1,   50,   0.5);
  _refs.MAX_WIDTH     = sliderRef('max width',  () => MAX_WIDTH,     v =>   MAX_WIDTH     = v,                        1,   100,  0.5);
  _refs.SPEED         = sliderRef('speed',      () => SPEED,         v =>   SPEED         = v,                        0.1, 18,   0.1);
  chk('wrap edges', () => WRAP_EDGES, v => WRAP_EDGES = v);

  sec('Atrator');
  _refs.ATTRACTOR_RADIUS   = sliderRef('raio',       () => ATTRACTOR_RADIUS,   v => ATTRACTOR_RADIUS   = v, 10,  500, 5);
  _refs.ATTRACTOR_STRENGTH = sliderRef('força',      () => ATTRACTOR_STRENGTH, v => ATTRACTOR_STRENGTH = v, 0.1, 16,  0.1);
  _refs.ATTRACTOR_DECAY    = sliderRef('decaimento', () => ATTRACTOR_DECAY,    v => ATTRACTOR_DECAY    = v, 0.001, 0.05, 0.001);
  _refs.ORBIT_DISTANCE     = sliderRef('raio órbita',() => ORBIT_DISTANCE,     v => ORBIT_DISTANCE     = v, 5,   300, 5);

  sec('Estilo');
  sel('draw style', ['solid', 'soft', 'outlined'], () => DRAW_STYLE, v => DRAW_STYLE = v);
  chk('fade tail', () => FADE_TAIL, v => FADE_TAIL = v);
  chk('bg fade',   () => BG_FADE,   v => BG_FADE   = v);
  _refs.BG_FADE_ALPHA = sliderRef('bg fade alpha', () => BG_FADE_ALPHA, v => BG_FADE_ALPHA = v, 2, 60, 1);

  sec('Cores');
  let satRef, lightRef;

  // Seletor de paletas predefinidas
  {
    const div = document.createElement('div'); div.className = 'ctrl';
    const lbl = document.createElement('label'); lbl.textContent = 'paleta preset';
    const s   = document.createElement('select');
    s.style.cssText = 'background:#333; color:#eee; border:1px solid #555; padding:2px 4px; font-family:monospace; font-size:11px; width:100%;';
    ['— custom —', ...Object.keys(PALETTES_PRESET)].forEach(o => {
      const op = document.createElement('option'); op.value = o; op.textContent = o; s.appendChild(op);
    });
    s.onchange = () => {
      if (s.value === '— custom —') return;
      PALETTE    = PALETTES_PRESET[s.value].map(c => [...c]);
      SAT_MULT   = 1.0;
      LIGHT_MULT = 1.0;
      if (satRef)   { satRef.inp.value   = 1.0; satRef.val.textContent   = '1.00'; }
      if (lightRef) { lightRef.inp.value = 1.0; lightRef.val.textContent = '1.00'; }
      rebuildColorEditor();
    };
    window._paletteSelect = s;
    div.appendChild(lbl); div.appendChild(s); panel.appendChild(div);
  }

  satRef   = _refs.SAT_MULT   = sliderRef('saturação', () => SAT_MULT,   v => { SAT_MULT   = v; if (window._paletteSelect) window._paletteSelect.value = '— custom —'; }, 0, 2.0, 0.05);
  lightRef = _refs.LIGHT_MULT = sliderRef('brilho',     () => LIGHT_MULT, v => { LIGHT_MULT = v; if (window._paletteSelect) window._paletteSelect.value = '— custom —'; }, 0, 2.0, 0.05);

  // Color picker para o fundo
  {
    const div = document.createElement('div'); div.className = 'ctrl';
    const lbl = document.createElement('label'); lbl.textContent = 'cor do fundo';
    const cp  = document.createElement('input'); cp.type = 'color';
    cp.value  = rgbToHex(BG_COLOR[0], BG_COLOR[1], BG_COLOR[2]);
    cp.style.cssText = 'width:100%; height:24px; border:none; background:none; cursor:pointer; padding:0;';
    cp.oninput = () => { const rgb = hexToRgb(cp.value); BG_COLOR = [rgb.r, rgb.g, rgb.b]; emitTheme(); };
    _refs.BG_COLOR_PICKER = cp;
    div.appendChild(lbl); div.appendChild(cp); panel.appendChild(div);
  }

  // Editor de cores da paleta (cor + probabilidade por entrada)
  const colorEditorEl = document.createElement('div'); colorEditorEl.id = 'color-editor'; panel.appendChild(colorEditorEl);

  function rebuildColorEditor() {
    colorEditorEl.innerHTML = '';
    const total = PALETTE.reduce((s, c) => s + c[3], 0);
    if (total > 0) PALETTE.forEach(c => c[3] /= total); // normaliza probabilidades

    PALETTE.forEach((c, i) => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex; align-items:center; gap:6px; margin-bottom:4px;';

      const cp = document.createElement('input'); cp.type = 'color';
      cp.value = rgbToHex(c[0], c[1], c[2]);
      cp.style.cssText = 'width:36px; height:24px; border:none; background:none; cursor:pointer; padding:0; flex-shrink:0;';
      cp.oninput = () => {
        const rgb = hexToRgb(cp.value);
        PALETTE[i][0] = rgb.r; PALETTE[i][1] = rgb.g; PALETTE[i][2] = rgb.b;
        if (window._paletteSelect) window._paletteSelect.value = '— custom —';
      };

      const probWrap = document.createElement('div');
      probWrap.style.cssText = 'flex:1; display:flex; flex-direction:column; gap:1px;';

      const probLbl = document.createElement('label');
      probLbl.style.cssText = 'color:#aaa; font-size:10px; display:flex; justify-content:space-between;';
      probLbl.appendChild(document.createTextNode('prob '));
      const probVal = document.createElement('span');
      probVal.style.color = '#f0a040'; probVal.textContent = c[3].toFixed(2);
      probLbl.appendChild(probVal);

      const probInp = document.createElement('input'); probInp.type = 'range';
      probInp.min = 0; probInp.max = 1; probInp.step = 0.01; probInp.value = c[3];
      probInp.style.cssText = 'width:100%; accent-color:#f0a040;';
      probInp.oninput = () => {
        if (window._paletteSelect) window._paletteSelect.value = '— custom —';
        const nv    = parseFloat(probInp.value);
        const ov    = PALETTE[i][3];
        const delta = nv - ov;
        const os    = 1 - ov;
        if (os < 0.001) return;
        PALETTE[i][3] = nv;
        // Redistribui a diferença proporcionalmente entre as demais cores
        PALETTE.forEach((cc, j) => {
          if (j === i) return;
          cc[3] = Math.max(0, cc[3] - delta * (cc[3] / os));
        });
        // Renormaliza
        const t = PALETTE.reduce((s, cc) => s + cc[3], 0);
        PALETTE.forEach(cc => cc[3] /= t);
        // Atualiza UI
        colorEditorEl.querySelectorAll('input[type=range]').forEach((inp, j) => { if (j !== i) inp.value = PALETTE[j][3]; });
        colorEditorEl.querySelectorAll('span').forEach((sp, j) => { sp.textContent = PALETTE[j][3].toFixed(2); });
        probVal.textContent = PALETTE[i][3].toFixed(2);
        probInp.value       = PALETTE[i][3];
      };

      probWrap.appendChild(probLbl); probWrap.appendChild(probInp);
      row.appendChild(cp); row.appendChild(probWrap);
      colorEditorEl.appendChild(row);
    });
  }
  rebuildColorEditor();
  window._rebuildColorEditor = rebuildColorEditor;

  sec('Seed');
  chk('fixed seed', () => USE_FIXED_SEED, v => { USE_FIXED_SEED = v; init(); });
  slider('seed', () => FIXED_SEED, v => { FIXED_SEED = v; if (USE_FIXED_SEED) init(); }, 1, 9999, 1);

  const row = document.createElement('div'); row.className = 'btn-row';
  const rb  = document.createElement('button'); rb.textContent = '⟳ REINICIAR'; rb.onclick = init;
  row.appendChild(rb); panel.appendChild(row);

  // Sincroniza todos os sliders do painel com os valores globais atuais
  // (chamado por applyState para manter o painel atualizado)
  function refreshAllSliders() {
    const map = {
      FIELD_SCALE, FIELD_ANGLE, FIELD_EVOLUTION,
      REPULSION_RADIUS, REPULSION_STRENGTH,
      NUM_PARTICLES, TRAIL_LENGTH, MIN_WIDTH, MAX_WIDTH, SPEED,
      ATTRACTOR_RADIUS, ATTRACTOR_STRENGTH, ATTRACTOR_DECAY, ORBIT_DISTANCE,
      BG_FADE_ALPHA, SAT_MULT, LIGHT_MULT,
      SPHERE_R_PCT, SPHERE_R_MIN, SPHERE_R_MAX, ROT_SPEED,
    };
    for (const k in map) {
      if (_refs[k]) {
        const ref  = _refs[k];
        const step = parseFloat(ref.inp.step);
        ref.inp.value      = map[k];
        ref.val.textContent = map[k].toFixed(step < 0.01 ? 4 : step < 1 ? 2 : 0);
      }
    }
    if (_refs.BG_COLOR_PICKER) _refs.BG_COLOR_PICKER.value = rgbToHex(BG_COLOR[0], BG_COLOR[1], BG_COLOR[2]);
    if (window._rebuildColorEditor) window._rebuildColorEditor();
    emitTheme();
  }
  window._refreshAllSliders = refreshAllSliders;
}
