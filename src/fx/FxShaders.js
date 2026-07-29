/**
 * Knockbots — shared GLSL for the effects systems.
 *
 * These chunks exist because the particle systems all solve the same handful of
 * problems and solving them once, correctly, is what keeps the look consistent:
 *
 *  - `GLSL_BALLISTIC` integrates a particle *analytically* from its spawn state,
 *    including floor bounces. That is the trick that makes the whole spark and
 *    debris layer free: nothing is stepped on the CPU and nothing is written
 *    back to a buffer, so a burst costs one attribute upload at spawn and zero
 *    work per frame afterwards. Bounces are found by solving the quadratic for
 *    the floor crossing, up to three times, which covers the visible lifetime of
 *    a spark before it settles.
 *
 *  - `GLSL_TEMPERATURE` is a fitted blackbody ramp rather than a lerp between
 *    two colours. Real hot metal goes white → yellow → orange → deep cherry red
 *    and *loses luminance an order of magnitude faster than it loses hue*; a
 *    naive lerp gives you the pastel-orange confetti that says "hobby project".
 *
 *  - `GLSL_CURL` reads the baked potential-gradient field and takes the
 *    perpendicular, giving a divergence-free flow. Divergence-free is the whole
 *    point: smoke that is advected by plain noise visibly compresses and
 *    expands, which the eye reads as "wrong" without being able to say why.
 *
 *  - `GLSL_DEPTH_FADE` is what stops a billboard from drawing its own outline.
 *    Every sprite that crosses opaque geometry cuts a hard circular arc across
 *    it, and that arc is the clearest possible statement that the effect is a
 *    quad rather than light in the air.
 */

/** Integer hash; the sine-fract kind bands badly on Apple GPUs. */
export const GLSL_HASH = /* glsl */ `
float hash11( float p ) {
  // int() first: float->uint of a negative value is undefined, int->uint is not.
  uint n = uint( int( p * 1000.0 ) ) * 747796405u + 2891336453u;
  n = ( ( n >> ( ( n >> 28u ) + 4u ) ) ^ n ) * 277803737u;
  return float( ( n >> 22u ) ^ n ) / 4294967295.0;
}`;

/** Easing curves shared by every timed effect. */
export const GLSL_EASE = /* glsl */ `
float easeOutCubic( float t )  { float f = 1.0 - t; return 1.0 - f * f * f; }
float easeOutQuint( float t )  { float f = 1.0 - t; return 1.0 - f * f * f * f * f; }
float easeInCubic( float t )   { return t * t * t; }
float easeOutExpo( float t )   { return t >= 1.0 ? 1.0 : 1.0 - exp2( -10.0 * t ); }
/** Fast rise, long settle — the shape almost every impact flash wants. */
float impulse( float k, float t ) { float h = k * t; return h * exp( 1.0 - h ); }`;

/**
 * Analytic ballistic integration with floor bounces and horizontal drag.
 * `uGravity` is signed (negative), `uRestitution` and `uTangentFriction` are the
 * bounce response, `uDrag` is the horizontal exponential decay rate.
 */
export const GLSL_BALLISTIC = /* glsl */ `
uniform float uGravity;
uniform float uRestitution;
uniform float uTangentFriction;
uniform float uDrag;

/** Horizontal displacement under exponential drag over dt. */
vec2 dragStep( vec2 v, float dt ) {
  float k = max( uDrag, 1e-4 );
  return v * ( 1.0 - exp( -k * dt ) ) / k;
}

/**
 * Position and velocity at time t after spawn, bouncing on the plane y=floorY.
 * Vertical motion is exact ballistic; horizontal carries exponential drag,
 * which is where the visual difference between a spark and a thrown rock lives.
 */
vec3 ballistic( vec3 p0, vec3 v0, float t, float floorY, out vec3 outVel, out float bounces ) {
  vec3 p = p0;
  vec3 v = v0;
  float rem = max( t, 0.0 );
  bounces = 0.0;
  float a = 0.5 * uGravity;

  for ( int i = 0; i < 3; i++ ) {
    float c = p.y - floorY;
    float disc = v.y * v.y - 4.0 * a * c;
    float th = 1e9;
    if ( disc > 0.0 && a != 0.0 ) {
      float sq = sqrt( disc );
      float r1 = ( -v.y - sq ) / ( 2.0 * a );
      float r2 = ( -v.y + sq ) / ( 2.0 * a );
      float lo = min( r1, r2 );
      float hi = max( r1, r2 );
      th = lo > 1e-4 ? lo : ( hi > 1e-4 ? hi : 1e9 );
    }
    if ( th >= rem ) break;

    p.xz += dragStep( v.xz, th );
    p.y = floorY;
    float vyAt = v.y + uGravity * th;
    v.xz *= exp( -uDrag * th ) * uTangentFriction;
    v.y = -vyAt * uRestitution;
    rem -= th;
    bounces += 1.0;
    if ( v.y < 0.4 ) { v = vec3( 0.0 ); rem = 0.0; break; }
  }

  p.xz += dragStep( v.xz, rem );
  p.y += v.y * rem + a * rem * rem;
  float decay = exp( -uDrag * rem );
  outVel = vec3( v.x * decay, v.y + uGravity * rem, v.z * decay );
  return p;
}`;

/**
 * Blackbody-ish emission ramp. t is 0 at ignition and 1 at burn-out.
 * Returns *radiance*, deliberately far above 1.0 at the head so the bloom pass
 * has something real to work with.
 *
 * The hue path has five stops, not three. White-hot, pale yellow, saturated
 * yellow, orange and finally a dark cherry that is well under the display range.
 * Three stops leaves the middle of the curve sitting on yellow for most of the
 * particle's life, and yellow at a radiance the tonemapper clips is gold — which
 * is how a burst ends up reading as confetti rather than as cooling metal.
 *
 * The luminance curve is three terms. A very steep ignition spike that is white
 * for about two frames and is what the bloom pass feeds on; the Stefan-Boltzmann
 * collapse under it; and a thin ember term that reaches *zero* at burn-out. The
 * ember term used to have a shallow exponent and a floor four times this high,
 * which kept every spark a visible object for its whole life — so the useful
 * lifetime of a burst was set by the buffer rather than by the curve.
 */
export const GLSL_TEMPERATURE = /* glsl */ `
/** 6500K white -> 4200K pale -> 3000K yellow -> 1900K orange -> 1100K cherry. */
vec3 blackbodyHue( float u ) {
  vec3 white  = vec3( 1.00, 0.99, 0.97 );
  vec3 pale   = vec3( 1.00, 0.92, 0.66 );
  vec3 yellow = vec3( 1.00, 0.74, 0.26 );
  vec3 orange = vec3( 1.00, 0.36, 0.05 );
  vec3 cherry = vec3( 0.58, 0.05, 0.01 );
  vec3 c = mix( white, pale, smoothstep( 0.00, 0.09, u ) );
  c = mix( c, yellow, smoothstep( 0.07, 0.30, u ) );
  c = mix( c, orange, smoothstep( 0.28, 0.60, u ) );
  return mix( c, cherry, smoothstep( 0.56, 0.94, u ) );
}

vec3 sparkEmission( float t, float heat ) {
  float u = clamp( t, 0.0, 1.0 );
  // Hue runs slightly ahead of the clock so the white phase stays short even on
  // the longest-lived tier.
  float hue = pow( u, 0.85 );
  float core  = pow( 1.0 - u, 10.0 ) * 2.6;
  float flash = pow( 1.0 - u, 3.2 ) * 0.62;
  float ember = ( 1.0 - u ) * ( 1.0 - u ) * 0.12;
  return blackbodyHue( hue ) * heat * ( core + flash + ember );
}`;

/**
 * Soft-particle depth fade against the pipeline's depth prepass.
 *
 * `uSoft` gates the sampler entirely, because the lower quality tiers have no
 * prepass to read and an unbound sampler is undefined behaviour, not zero.
 */
export const GLSL_DEPTH_FADE = /* glsl */ `
uniform sampler2D uDepth;
uniform vec2 uResolution;
uniform float uNear;
uniform float uFar;
uniform float uSoft;

float viewZFromDepth( float d ) {
  return ( uNear * uFar ) / ( ( uFar - uNear ) * d - uFar );
}

/** 0 where the sprite meets the depth buffer, 1 at range metres in front of it. */
float depthFade( float viewZ, float range ) {
  if ( uSoft < 0.5 ) return 1.0;
  float d = texture2D( uDepth, gl_FragCoord.xy / uResolution ).x;
  float sceneZ = -viewZFromDepth( d );
  return clamp( ( sceneZ - viewZ ) / max( range, 0.02 ), 0.0, 1.0 );
}`;

/** Divergence-free 2D advection from the baked potential-gradient field. */
export const GLSL_CURL = /* glsl */ `
uniform sampler2D uCurl;

vec2 curl2( vec2 p ) {
  vec2 g = texture2D( uCurl, fract( p ) ).rg * 2.0 - 1.0;
  return vec2( g.y, -g.x );
}

/** Two-octave curl advection integrated with a midpoint step. */
vec3 curlAdvect( vec3 base, float t, float scale, float strength ) {
  vec2 p = base.xz * scale;
  vec2 f1 = curl2( p + vec2( 0.0, t * 0.06 ) );
  vec2 f2 = curl2( p * 2.7 + vec2( t * 0.11, 0.0 ) ) * 0.45;
  vec2 flow = ( f1 + f2 ) * strength;
  float rise = ( f1.x + f2.y ) * strength * 0.5;
  return base + vec3( flow.x, rise, flow.y ) * t;
}`;

/**
 * Expands an instanced unit quad into a camera-facing (or velocity-stretched)
 * billboard in view space. corner is the quad vertex in [-0.5,0.5].
 */
export const GLSL_BILLBOARD = /* glsl */ `
vec4 billboard( vec3 worldPos, vec2 corner, float size, float roll ) {
  vec4 mv = viewMatrix * vec4( worldPos, 1.0 );
  float s = sin( roll ), c = cos( roll );
  mv.xy += mat2( c, s, -s, c ) * corner * size;
  return mv;
}

/**
 * Velocity-aligned billboard. Falls back to a round billboard when the screen
 * space velocity is too small to define a direction, which is what stops
 * slow particles from flickering between orientations.
 */
vec4 streakBillboard( vec3 worldPos, vec3 worldVel, vec2 corner, float width, float len, out float alongT ) {
  vec4 mv = viewMatrix * vec4( worldPos, 1.0 );
  vec3 vv = ( viewMatrix * vec4( worldVel, 0.0 ) ).xyz;
  float m = length( vv.xy );
  vec2 dir = m > 1e-3 ? vv.xy / m : vec2( 0.0, 1.0 );
  vec2 side = vec2( -dir.y, dir.x );
  mv.xy += dir * ( corner.y * len ) + side * ( corner.x * width );
  alongT = corner.y + 0.5;
  return mv;
}`;
