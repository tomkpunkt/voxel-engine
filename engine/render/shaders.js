// GLSL für das WebGL2-Backend.
// Geometriepass: jede Höhenscheibe ist ein Quad (Instanz); Tiefe nur aus z.
// Lichtpass: ein Dreieck über den Bildschirm, liest den G-Buffer und die Höhenkarte.

export const VS_G = `#version 300 es
layout(location=0) in vec2 aC;
layout(location=1) in vec4 aI;   // Ebene im Textur-Array, Höhe z, Ursprung x, y (Welt bzw. Sprite)
layout(location=2) in vec4 aS;   // Größe w, h und Texel-Ursprung u, v
uniform mat3 uM; uniform vec2 uTex, uScreen; uniform float uDzu, uZMax;
out vec2 vUV, vLoc; flat out float vL; out float vZ;
void main(){
  vec2 loc = aI.zw + aC * aS.xy;
  vec3 s = uM * vec3(loc, 1.0);
  float sy = s.y - aI.y * uDzu;
  vUV = (aS.zw + aC * aS.xy) / uTex; vLoc = loc; vL = aI.x; vZ = aI.y;
  gl_Position = vec4(s.x / uScreen.x * 2.0 - 1.0, 1.0 - sy / uScreen.y * 2.0, 0.999 - 2.0 * aI.y / uZMax, 1.0);
}`;

export const FS_G = `#version 300 es
precision highp float; precision highp sampler2DArray;
uniform sampler2DArray uA, uB;
uniform mat2 uRot; uniform vec4 uCut, uTint; uniform vec2 uOv; uniform float uGhost, uEnt, uHiAll, uZMax;
uniform vec4 uHiR[6], uHiZ[6];   // Hervorhebung: Rechteck (Welt), z-Bereich, Art (1 gelb, 0.5 rot)
in vec2 vUV, vLoc; flat in float vL; in float vZ;
layout(location=0) out vec4 o0; layout(location=1) out vec4 o1;
layout(location=2) out vec4 o2; layout(location=3) out vec4 o3;
vec3 octDec(vec2 e){ vec2 v = e * 2.0 - 1.0; vec3 n = vec3(v, 1.0 - abs(v.x) - abs(v.y)); float t = max(-n.z, 0.0);
  n.x += n.x >= 0.0 ? -t : t; n.y += n.y >= 0.0 ? -t : t; return normalize(n); }
void main(){
  vec3 t = vec3(vUV, vL);
  vec4 a = texture(uA, t); if (a.a < 0.5) discard;
  vec4 b = texture(uB, t);
  int fl = int(b.a * 255.0 + 0.5), bb = int(b.b * 255.0 + 0.5);
  // Kappen: Dach und obere Wandhälften im Rechteck uCut weglassen (Gebäude, in dem die Figur steht)
  if ((fl & 3) != 0 && vLoc.x >= uCut.x && vLoc.y >= uCut.y && vLoc.x < uCut.z && vLoc.y < uCut.w) discard;
  vec3 nn = octDec(b.rg); nn.xy = uRot * nn.xy;
  o0 = vec4(mix(a.rgb, uTint.rgb, uTint.a), 1.0);
  o1 = vec4(nn * 0.5 + 0.5, float(bb & 127) / 127.0);
  o2 = vec4(uOv.x > 0.5 ? uOv.y : float(bb >> 7), uEnt / 255.0, (fl & 4) != 0 ? 1.0 : 0.0, vZ / uZMax);
  float hi = uHiAll;
  for (int i = 0; i < 6; i++) {
    if (uHiZ[i].z <= 0.0) continue;
    if (vLoc.x >= uHiR[i].x && vLoc.y >= uHiR[i].y && vLoc.x < uHiR[i].z && vLoc.y < uHiR[i].w && vZ >= uHiZ[i].x && vZ < uHiZ[i].y) hi = uHiZ[i].z;
  }
  o3 = vec4(uGhost, hi, 0.0, 0.0);
}`;

export const VS_L = `#version 300 es
void main(){ vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2); gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }`;

export const FS_L = `#version 300 es
precision highp float; precision highp int;
uniform sampler2D tA, tN, tX, tG, tH;
uniform vec2 uScreen, uWorld; uniform mat3 uInv; uniform float uDzu, uGA, uFlash, uZMax, uQuant, uLos;
uniform vec3 uAmb, uSun, uSunC, uEye, uGhostC;
uniform vec4 uLP[8]; uniform vec4 uLC[8]; uniform vec4 uSpot;
out vec4 o;
float bayer(ivec2 p){ int x = p.x & 3, y = p.y & 3;
  int m[16] = int[16](0,8,2,10,12,4,14,6,3,11,1,9,15,7,13,5); return float(m[y*4+x]) / 16.0 - 0.47; }
// Schatten und Sichtlinie über die Höhenkarte, Schritte von 1 Voxel (dünne Wände werden nicht übersprungen)
float hvis(vec3 P, vec3 L){
  vec3 d = L - P; float len = length(d.xy);
  float n = min(ceil(len), 96.0);
  for (float k = 1.0; k < 96.0; k++) {
    if (k >= n) break;
    vec3 q = P + d * (k / n);
    if (texture(tH, q.xy / uWorld).r * 255.0 > q.z) return 0.0;
  }
  return 1.0;
}
// Weiche Kanten: zwei Strahlen zu seitlich versetzten Punkten an der Quelle, Versatz Bayer-gestreut
float hvisAA(vec3 P, vec3 L, float r, float j){
  vec2 d = L.xy - P.xy; float l = length(d);
  if (l < 0.01) return 1.0;
  vec3 o = vec3(vec2(-d.y, d.x) / l * r, 0.0);
  return 0.5 * (hvis(P, L + o * (0.5 + j)) + hvis(P, L - o * (0.5 - j)));
}
void main(){
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 a = texelFetch(tA, p, 0);
  if (a.a < 0.5) { o = vec4(0.0, 0.0, 0.0, 1.0); return; }
  vec4 n4 = texelFetch(tN, p, 0); vec3 n = normalize(n4.xyz * 2.0 - 1.0); float ao = n4.a;
  vec4 x = texelFetch(tX, p, 0); float z = x.a * uZMax; int fl = int(x.g * 255.0 + 0.5);
  vec2 wp = (uInv * vec3(gl_FragCoord.x, uScreen.y - gl_FragCoord.y + z * uDzu, 1.0)).xy;
  vec3 P = vec3(wp, z + 0.5) + n * 0.6;
  vec3 col;
  if (x.b > 0.5) col = a.rgb * 1.3;
  else {
    vec3 lit = uAmb * ao + uSunC * (1.0 + uFlash * 5.0) * max(dot(n, uSun), 0.0) * x.r;
    for (int i = 0; i < 8; i++) {
      if (uLC[i].a < 0.5) continue;
      vec3 d = uLP[i].xyz - P; float dist = length(d);
      if (dist >= uLP[i].w) continue;
      vec3 l = d / dist;
      float att = pow(1.0 - dist / uLP[i].w, 2.0) * (max(dot(n, l), 0.0) * 0.8 + 0.2);
      if (i == 0 && uSpot.w > -1.5) { float c = dot(-l, uSpot.xyz); att *= smoothstep(uSpot.w, uSpot.w + 0.13, c) * (0.75 + 0.25 * smoothstep(uSpot.w + 0.05, 1.0, c)); }
      if (att < 0.004) continue;
      if (uLC[i].a > 1.5) att *= i == 0 ? hvisAA(P, uLP[i].xyz, 0.9, bayer(p)) : hvis(P, uLP[i].xyz);
      lit += uLC[i].rgb * att;
    }
    col = a.rgb * lit;
  }
  if (uLos > 0.5) {   // Bereiche außerhalb der Sicht grau, Gegner fast schwarz
    float vis = hvisAA(P, uEye, 0.55, bayer(p.yx));
    float g = dot(col, vec3(0.3, 0.55, 0.15));
    if ((fl & 2) == 2) col *= mix(0.05, 1.0, vis);
    else col = mix(vec3(g) * vec3(0.6, 0.65, 0.8) * 0.6, col, vis);
  }
  if (uQuant > 0.0) col = floor(col * uQuant + 0.5 + bayer(p)) / uQuant;
  vec2 g0 = texelFetch(tG, p, 0).rg;
  col = mix(col, uGhostC, g0.r * uGA);
  // 1-px-Umriss: unmarkierter Pixel mit markiertem 4-Nachbarn, höchstens 5 von 8 markiert (sonst Lücke im Objekt)
  if (g0.g < 0.1 && fl != 1) {
    float h = 0.0, cnt = 0.0, c4 = 0.0;
    for (int dy = -1; dy <= 1; dy++) for (int dx = -1; dx <= 1; dx++) {
      if (dx == 0 && dy == 0) continue;
      float v = texelFetch(tG, p + ivec2(dx, dy), 0).g;
      if (v > 0.1) { cnt += 1.0; h = max(h, v); if (dx == 0 || dy == 0) c4 += 1.0; }
    }
    if (c4 > 0.0 && cnt <= 5.0) {
      if (h > 0.75) col = vec3(1.0, 0.82, 0.2) * (0.8 + 0.4 * uGA);
      else col = vec3(0.95, 0.15, 0.1) * (0.8 + 0.4 * uGA);
    }
  }
  o = vec4(col, 1.0);
}`;
