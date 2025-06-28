const song = document.getElementById('music');
const toggle = document.getElementById('toggle-music');

toggle.addEventListener('click', () => {
	if(song.paused) {
		song.play();
		toggle.classList.add('is-playing');
	}else{
		song.pause();
		toggle.classList.remove('is-playing');
	}
});

// cache-break download urls
const now = Date.now();
for(const link of document.querySelectorAll('a[href*=".user.js"]')) {
	link.href += `?v=${now}`;
}

// background canvas
const bg_aspect = 1200 / 1920;
var programOutput, programPropagation;
var vertBuffer;
var textureBackground, textureDither;
var texturePropagation1, texturePropagation2;
var texBuffer1, texBuffer2;
var framebufferPropagation;
var adj_res_w = window.innerWidth;
var adj_res_h = window.innerHeight;
var adj_res_dx = 0;
var adj_res_dy = 0;
var mouse_x = 0;
var mouse_y = 0;
var mouse_strength = 0;
var frame_count = 0;

const vertSource = `
precision mediump float;
attribute vec4 position;
void main() {
	gl_Position = position;
}`;

// modified from: https://www.shadertoy.com/view/4dK3Ww
const propagationFragSource = `
precision mediump float;
uniform vec2 resolution;
uniform float time;
uniform float frames;
uniform vec2 mouse;
uniform float strength;
uniform sampler2D inputTexture;

void main() {
	vec3 e = vec3(vec2(1.0) / resolution.xy, 0.0);
	vec2 q = gl_FragCoord.xy / resolution.xy;
	vec4 c = texture2D(inputTexture, q);

	float p11 = c.y;
	float p10 = texture2D(inputTexture, q - e.zy).x;
	float p01 = texture2D(inputTexture, q - e.xz).x;
	float p21 = texture2D(inputTexture, q + e.xz).x;
	float p12 = texture2D(inputTexture, q + e.zy).x;

	float d = 0.0;
	float len = length(mouse.xy - gl_FragCoord.xy);

	if(strength > 0.0 && len <= 50.0) {
		d = smoothstep(50.0, 2.0, len) * 0.25;
	}else{
		float t = time * 5.0;
		vec2 pos = fract(floor(t) * vec2(0.456665, 0.708618)) * resolution.xy;
		float amp = 1.0 - step(0.05, fract(t));
		d = -amp * smoothstep(10.0, 1.0, length(pos - gl_FragCoord.xy));
	}

	d += -(p11 - 0.5) * 2.0 + (p10 + p01 + p21 + p12 - 2.0);
	d *= 0.99;
	d *= float(frames > 10.0);
	d = d * 0.5 + 0.5;

	gl_FragColor = vec4(d, c.x, 0, 0);
}`;

const outputFragSource = `
precision mediump float;
uniform vec2 resolution;
uniform vec2 adjustedResolution;
uniform vec2 aspectOffset;
uniform sampler2D background;
uniform sampler2D dither;
uniform sampler2D wave;

const float bg_aspect = 1200.0 / 1920.0;
const vec2 dither_size = vec2(4.0, -4.0);

float overlay( float S, float D ) {
	return float( D > 0.5 ) * ( 2.0 * (S + D - D * S ) - 1.0 ) + float( D <= 0.5 ) * ( ( 2.0 * D ) * S );
}

vec4 overlay_blend(vec4 base, vec4 top) {
	return vec4(mix(
		vec3(overlay(top.r, base.r), overlay(top.g, base.g), overlay(top.b, base.b)),
		base.rgb,
		1.0 - top.a
	), base.a);
}

void main() {
	vec2 q = gl_FragCoord.xy / resolution.xy;
	vec2 uv_aspect = (gl_FragCoord.xy + aspectOffset) / adjustedResolution.xy;

	vec3 e = vec3(vec2(1.0) / resolution.xy, 0.0);
	float p10 = texture2D(wave, q - e.zy).x;
	float p01 = texture2D(wave, q - e.xz).x;
	float p21 = texture2D(wave, q + e.xz).x;
	float p12 = texture2D(wave, q + e.zy).x;

	vec3 grad = normalize(vec3(p21 - p01, p12 - p10, 1.0));
	vec4 c = texture2D(background, vec2(uv_aspect.x, 1.0 - uv_aspect.y) + grad.xy * 0.1);
	vec3 light = normalize(vec3(0.2, -0.5, 0.7));
	float specular = pow(max(0.0, -reflect(light, grad).z), 64.0);
	vec4 color_bg = c + specular * 10.0;

	vec4 color_dither = texture2D(dither, gl_FragCoord.xy / dither_size);
	gl_FragColor = overlay_blend(overlay_blend(color_bg, color_dither), color_dither * 0.5);
}`;

function render(gl) {
	let time = performance.now();
	let lastTime = performance.now();
	let last_mouse_x = mouse_x;
	let last_mouse_y = mouse_y;

	const propagationAttribPosition       = gl.getAttribLocation(programPropagation, 'position');
	const propagationUniformResolution    = gl.getUniformLocation(programPropagation, 'resolution');
	const propagationUniformTime          = gl.getUniformLocation(programPropagation, 'time');
	const propagationUniformFrameCount          = gl.getUniformLocation(programPropagation, 'frames');
	const propagationUniformMouse         = gl.getUniformLocation(programPropagation, 'mouse');
	const propagationUniformStrength      = gl.getUniformLocation(programPropagation, 'strength');
	const propagationUniformInputTexture  = gl.getUniformLocation(programPropagation, 'inputTexture');

	const outputAttribPosition            = gl.getAttribLocation(programOutput, 'position');
	const outputUniformResolution         = gl.getUniformLocation(programOutput, 'resolution');
	const outputUniformAdjustedResolution = gl.getUniformLocation(programOutput, 'adjustedResolution');
	const outputUniformAspectOffset       = gl.getUniformLocation(programOutput, 'aspectOffset');
	const outputSamplerBackground         = gl.getUniformLocation(programOutput, 'background');
	const outputSamplerDither             = gl.getUniformLocation(programOutput, 'dither');
	const outputSamplerWave               = gl.getUniformLocation(programOutput, 'wave');

	function propagate(time) {
		const mouse_dx = Math.abs(mouse_x - last_mouse_x);
		const mouse_dy = Math.abs(mouse_y - last_mouse_y);
		const mouse_len = Math.sqrt(mouse_dx * mouse_dx + mouse_dy * mouse_dy);
		mouse_strength = mouse_len < 1 ? 0 : Math.min(20, mouse_len);
		last_mouse_x = mouse_x;
		last_mouse_y = mouse_y;

		gl.useProgram(programPropagation);

		gl.bindFramebuffer(gl.FRAMEBUFFER, framebufferPropagation);

		gl.uniform2f(propagationUniformResolution, gl.canvas.width, gl.canvas.height);
		gl.uniform1f(propagationUniformTime, time);
		gl.uniform1f(propagationUniformFrameCount, frame_count);
		gl.uniform2f(propagationUniformMouse, mouse_x, gl.canvas.height - mouse_y);
		gl.uniform1f(propagationUniformStrength, mouse_strength);

		gl.activeTexture(gl.TEXTURE2);
		gl.bindTexture(gl.TEXTURE_2D, texturePropagation1);
		gl.uniform1i(propagationUniformInputTexture, 2);

		gl.bindBuffer(gl.ARRAY_BUFFER, vertBuffer);
		gl.vertexAttribPointer(propagationAttribPosition, 2, gl.FLOAT, false, 0, 0);
		gl.enableVertexAttribArray(propagationAttribPosition);
		gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
		gl.copyTexImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 0, 0, gl.canvas.width, gl.canvas.height, 0);


		gl.bindFramebuffer(gl.FRAMEBUFFER, null);

		gl.useProgram(null);
	}

	function output() {
		gl.useProgram(programOutput);

		gl.clear(gl.COLOR_BUFFER_BIT);

		gl.activeTexture(gl.TEXTURE0);
		gl.bindTexture(gl.TEXTURE_2D, textureBackground);
		gl.uniform1i(outputSamplerBackground, 0);

		gl.activeTexture(gl.TEXTURE1);
		gl.bindTexture(gl.TEXTURE_2D, textureDither);
		gl.uniform1i(outputSamplerDither, 1);

		gl.activeTexture(gl.TEXTURE3);
		gl.bindTexture(gl.TEXTURE_2D, texturePropagation2);
		gl.uniform1i(outputSamplerWave, 3);

		gl.uniform2f(outputUniformResolution, gl.canvas.width, gl.canvas.height);
		gl.uniform2f(outputUniformAdjustedResolution, adj_res_w, adj_res_h);
		gl.uniform2f(outputUniformAspectOffset, adj_res_dx, adj_res_dy);

		gl.bindBuffer(gl.ARRAY_BUFFER, vertBuffer);
		gl.vertexAttribPointer(outputAttribPosition, 2, gl.FLOAT, false, 0, 0);
		gl.enableVertexAttribArray(outputAttribPosition);
		gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

		gl.useProgram(null);
	}

	function render_frame() {
		frame_count++;
		time = performance.now();
		const t = time / 1000;
		lastTime = time;

		propagate(t);
		output();

		window.requestAnimationFrame(render_frame);
	}
	window.requestAnimationFrame(render_frame);
}

function loadShader(gl, type, source) {
	const shader = gl.createShader(type);

	gl.shaderSource(shader, source);
	gl.compileShader(shader);

	if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
		console.log(`An error occurred compiling the shaders: ${gl.getShaderInfoLog(shader)}`);
		gl.deleteShader(shader);
		return null;
	}

	return shader;
}

function initShaderProgram(gl, vert, frag) {
	const vertexShader = loadShader(gl, gl.VERTEX_SHADER, vert);
	const fragmentShader = loadShader(gl, gl.FRAGMENT_SHADER, frag);

	const shaderProgram = gl.createProgram();
	gl.attachShader(shaderProgram, vertexShader);
	gl.attachShader(shaderProgram, fragmentShader);
	gl.linkProgram(shaderProgram);

	if (!gl.getProgramParameter(shaderProgram, gl.LINK_STATUS)) {
		consle.log(`Unable to initialize the shader program: ${gl.getProgramInfoLog(shaderProgram,)}`);
		return null;
	}

	return shaderProgram;
}

function isPowerOf2(value) {return (value & (value - 1)) === 0}

function loadTexture(gl, url) {
	const texture = gl.createTexture();
	gl.bindTexture(gl.TEXTURE_2D, texture);

	const pixel = new Uint8Array([255, 255, 255, 255]);
	gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixel);

	const image = new Image();
	image.onload = () => {
		gl.bindTexture(gl.TEXTURE_2D, texture);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);

		if (isPowerOf2(image.width) && isPowerOf2(image.height)) {
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
		} else {
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
		}
	}
	image.src = url;

	return texture;
}

function genPropgationTexture(gl, tex, buffer) {
	gl.bindTexture(gl.TEXTURE_2D, tex);
	buffer = new Uint8Array(gl.canvas.width * gl.canvas.height * 4);
	gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.canvas.width, gl.canvas.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, buffer);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
}

function resizeCanvas() {
	const gl = document.getElementById('background')?.getContext('webgl');
	if(!gl) return;
	const w = window.innerWidth;
	const h = window.innerHeight;

	gl.canvas.width = w;
	gl.canvas.height = h;
	gl.viewport(0, 0, w, h);
	if(w === 0 || h === 0) return;

	adj_res_dx = 0;
	adj_res_dy = 0;
	adj_res_w = w;
	adj_res_h = h;

	if(h / w < bg_aspect) {
		adj_res_h = w * bg_aspect;
		adj_res_dy = (adj_res_h - h) / 2;
	}else{
		adj_res_w = h / bg_aspect;
		adj_res_dx = (adj_res_w - w) / 2;
	}

	genPropgationTexture(gl, texturePropagation1, texBuffer1);
	genPropgationTexture(gl, texturePropagation2, texBuffer2);
	frame_count = 0;
}

function mouseMove(e) {
	mouse_x = e.clientX;
	mouse_y = e.clientY;
}

function fallback() {
	document.body.classList.add('image-fallback');
}

function initCanvas() {
	const gl = document.getElementById('background')?.getContext('webgl');
	if(!gl) { fallback(); return };

	programPropagation = initShaderProgram(gl, vertSource, propagationFragSource);
	if(!programPropagation) { fallback(); return };

	programOutput = initShaderProgram(gl, vertSource, outputFragSource);
	if(!programOutput) { fallback(); return };

	gl.clearColor(1, 1, 1, 1);

	vertBuffer = gl.createBuffer();
	gl.bindBuffer(gl.ARRAY_BUFFER, vertBuffer);
	const verts = [1, 1, -1, 1, 1, -1, -1, -1];
	gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.STATIC_DRAW);

	textureBackground = loadTexture(gl, 'images/bg.jpg');
	textureDither = loadTexture(gl, 'images/dither.png');

	texturePropagation1 = gl.createTexture();
	texturePropagation2 = gl.createTexture();

	resizeCanvas();
	window.addEventListener('resize', resizeCanvas);
	window.addEventListener('mousemove', mouseMove);

	framebufferPropagation = gl.createFramebuffer();
	gl.bindFramebuffer(gl.FRAMEBUFFER, framebufferPropagation);
	gl.bindTexture(gl.TEXTURE_2D, texturePropagation2);
	gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texturePropagation2, 0);

	render(gl);
}

initCanvas();
