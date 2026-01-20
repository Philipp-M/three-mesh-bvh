import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GUI } from 'three/examples/jsm/libs/lil-gui.module.min.js';
import Stats from 'stats.js';
import { GenerateMeshBVHWorker } from 'three-mesh-bvh/worker';
import { StaticGeometryGenerator } from 'three-mesh-bvh';
import { GenerateSDFMaterial } from './utils/GenerateSDFMaterial.js';
import { RenderSDFLayerMaterial } from './utils/RenderSDFLayerMaterial.js';
import { RayMarchSDFMaterial } from './utils/RayMarchSDFMaterial.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

const params = {

	gpuGeneration: true,
	resolution: 16,
	margin: 0,
	regenerate: () => updateSDF(),

	mode: 'raymarching',
	layer: 0,
	surface: 0,

};

let renderer, camera, scene, gui, stats, boxHelper;
let outputContainer, bvh, geometry, sdfTex, mesh;
let generateSdfPass, layerPass, raymarchPass;
let bvhGenerationWorker;
const inverseBoundsMatrix = new THREE.Matrix4();

init();
render();

function init() {

	outputContainer = document.getElementById( 'output' );

	// renderer setup
	renderer = new THREE.WebGLRenderer( { antialias: true } );
	renderer.setPixelRatio( window.devicePixelRatio );
	renderer.setSize( window.innerWidth, window.innerHeight );
	renderer.setClearColor( 0, 0 );
	document.body.appendChild( renderer.domElement );

	// scene setup
	scene = new THREE.Scene();

	const light = new THREE.DirectionalLight( 0xffffff, 1 );
	light.position.set( 1, 1, 1 );
	scene.add( light );
	scene.add( new THREE.AmbientLight( 0xffffff, 0.2 ) );

	// camera setup
	camera = new THREE.PerspectiveCamera( 75, window.innerWidth / window.innerHeight, 0.1, 50 );
	camera.position.set( 1, 1, 2 );
	camera.far = 100;
	camera.updateProjectionMatrix();

	boxHelper = new THREE.Box3Helper( new THREE.Box3() );
	scene.add( boxHelper );

	new OrbitControls( camera, renderer.domElement );

	// stats setup
	stats = new Stats();
	document.body.appendChild( stats.dom );

	// sdf pass to generate the 3d texture
	generateSdfPass = new FullScreenQuad( new GenerateSDFMaterial() );

	// screen pass to render a single layer of the 3d texture
	layerPass = new FullScreenQuad( new RenderSDFLayerMaterial() );

	// screen pass to render the sdf ray marching
	raymarchPass = new FullScreenQuad( new RayMarchSDFMaterial() );

	// load model and generate bvh
	bvhGenerationWorker = new GenerateMeshBVHWorker();

	new GLTFLoader()
		.setMeshoptDecoder( MeshoptDecoder )
		.loadAsync( 'https://raw.githubusercontent.com/gkjohnson/3d-demo-data/main/models/stanford-bunny/bunny.glb' )
		.then( gltf => {

			gltf.scene.updateMatrixWorld( true );

			const staticGen = new StaticGeometryGenerator( gltf.scene );
			staticGen.attributes = [ 'position', 'normal' ];
			staticGen.useGroups = false;

			geometry = staticGen.generate().center();

			return bvhGenerationWorker.generate( geometry, { maxLeafTris: 1 } );

		} )
		.then( result => {

			bvh = result;

			mesh = new THREE.Mesh( geometry, new THREE.MeshStandardMaterial() );
			scene.add( mesh );

			updateSDF();

		} );

	rebuildGUI();

	window.addEventListener( 'resize', function () {

		camera.aspect = window.innerWidth / window.innerHeight;
		camera.updateProjectionMatrix();

		renderer.setSize( window.innerWidth, window.innerHeight );

	}, false );

}

// build the gui with parameters based on the selected display mode
function rebuildGUI() {

	if ( gui ) {

		gui.destroy();

	}

	params.layer = Math.min( params.resolution, params.layer );

	gui = new GUI();

	const generationFolder = gui.addFolder( 'generation' );
	generationFolder.add( params, 'gpuGeneration' );
	generationFolder.add( params, 'resolution', 10, 200, 1 );
	generationFolder.add( params, 'margin', 0, 1 );
	generationFolder.add( params, 'regenerate' );

	const displayFolder = gui.addFolder( 'display' );
	displayFolder.add( params, 'mode', [ 'geometry', 'raymarching', 'layer', 'grid layers' ] ).onChange( () => {

		rebuildGUI();

	} );

	if ( params.mode === 'layer' ) {

		displayFolder.add( params, 'layer', 0, params.resolution, 1 );

	}

	if ( params.mode === 'raymarching' ) {

		displayFolder.add( params, 'surface', - 0.2, 0.5 );

	}

}

// update the sdf texture based on the selected parameters
function updateSDF() {

	const dim = params.resolution;
	const matrix = new THREE.Matrix4();
	const center = new THREE.Vector3();
	const quat = new THREE.Quaternion();
	const scale = new THREE.Vector3(2, 2, 2);

	// compute the bounding box of the geometry including the margin which is used to
	// define the range of the SDF
	geometry.boundingBox.getCenter( center );
	scale.subVectors( geometry.boundingBox.max, geometry.boundingBox.min );
	console.log( geometry.boundingBox.max, geometry.boundingBox.min );
	scale.y = scale.x;
	scale.z = scale.x;
	scale.x += 2 * params.margin;
	scale.y += 2 * params.margin;
	scale.z += 2 * params.margin;
	matrix.compose( center, quat, scale );
	inverseBoundsMatrix.copy( matrix ).invert();

	// update the box helper
	boxHelper.box.copy( geometry.boundingBox );
	boxHelper.box.min.x -= params.margin;
	boxHelper.box.min.y -= params.margin;
	boxHelper.box.min.z -= params.margin;
	boxHelper.box.max.x += params.margin;
	boxHelper.box.max.y += params.margin;
	boxHelper.box.max.z += params.margin;

	// dispose of the existing sdf
	if ( sdfTex ) {

		sdfTex.dispose();
		sdfTex = null;

	}

	const pxWidth = 1 / dim;
	const halfWidth = 0.5 * pxWidth;

	const startTime = window.performance.now();
	if ( params.gpuGeneration ) {

		// create a new 3d render target texture
		const floatLinearExtSupported = renderer.extensions.get( 'OES_texture_float_linear' );
		sdfTex = new THREE.WebGL3DRenderTarget( dim, dim, dim );
		sdfTex.texture.format = THREE.RedFormat;
		sdfTex.texture.type = floatLinearExtSupported ? THREE.FloatType : THREE.HalfFloatType;
		sdfTex.texture.minFilter = THREE.LinearFilter;
		sdfTex.texture.magFilter = THREE.LinearFilter;
		renderer.initRenderTarget( sdfTex );

		// prep the sdf generation material pass
		generateSdfPass.material.uniforms.bvh.value.updateFrom( bvh );
		generateSdfPass.material.uniforms.matrix.value.copy( matrix );

		// create a 2d render target to render in to
		const scratchVec = new THREE.Vector3();
		const scratchTarget = new THREE.WebGLRenderTarget( dim, dim );
		scratchTarget.texture.format = THREE.RedFormat;
		scratchTarget.texture.type = floatLinearExtSupported ? THREE.FloatType : THREE.HalfFloatType;

		// render into each layer
		for ( let i = 0; i < dim; i ++ ) {

			generateSdfPass.material.uniforms.zValue.value = i * pxWidth + halfWidth;

			renderer.setRenderTarget( scratchTarget );
			generateSdfPass.render( renderer );

			// copy the data into the 3d texture since rendering directly into the target causes significant gpu artifacts
			// See issue #720
			scratchVec.z = i;
			renderer.copyTextureToTexture( scratchTarget.texture, sdfTex.texture, null, scratchVec );

		}

		// initiate read back to get a rough estimate of time taken to generate the sdf
		renderer.readRenderTargetPixels( scratchTarget, 0, 0, 1, 1, new Float32Array( 4 ) );
		renderer.setRenderTarget( null );
		scratchTarget.dispose();

	} else {
		const dd = new SdfAtlasDecoder();
		dd.decode("/sdf.avif").then((v) => {

			if ( v.edgeLen ** 3 != v.distances.length ) {

				throw new Error( "SHIT" );

			}

			sdfTex = new THREE.Data3DTexture(
				v.distances,
				v.edgeLen,
				v.edgeLen,
				v.edgeLen,
			);

			sdfTex.format = THREE.RedFormat;
			sdfTex.type = THREE.FloatType;
			sdfTex.minFilter = THREE.LinearFilter;
			sdfTex.magFilter = THREE.LinearFilter;
			sdfTex.needsUpdate = true;

		});
		// const img = document.createElement("img");
		// img.src = "/sdf.avif";
		// img.onload = () => {
		// 	sdfTex = atlasToData3DTexture(img);
		// };
		// loadAtlasTiledToData3DTexture(renderer, "/sdf.avif").then(tex => {
		// 	sdfTex = tex;
		// });
		// // create a new 3d data texture
		// sdfTex = new THREE.Data3DTexture( new Float32Array( dim ** 3 ), dim, dim, dim );
		// sdfTex.format = THREE.RedFormat;
		// sdfTex.type = THREE.FloatType;
		// sdfTex.minFilter = THREE.LinearFilter;
		// sdfTex.magFilter = THREE.LinearFilter;
		// sdfTex.needsUpdate = true;

		// const point = new THREE.Vector3();
		// const ray = new THREE.Ray();
		// const target = {};

		// // iterate over all pixels and check distance
		// for ( let x = 0; x < dim; x ++ ) {

		// 	for ( let y = 0; y < dim; y ++ ) {

		// 		for ( let z = 0; z < dim; z ++ ) {

		// 			// adjust by half width of the pixel so we sample the pixel center
		// 			// and offset by half the box size.
		// 			point.set(
		// 				halfWidth + x * pxWidth - 0.5,
		// 				halfWidth + y * pxWidth - 0.5,
		// 				halfWidth + z * pxWidth - 0.5,
		// 			).applyMatrix4( matrix );

		// 			const index = x + y * dim + z * dim * dim;
		// 			const dist = bvh.closestPointToPoint( point, target ).distance;

		// 			// raycast inside the mesh to determine if the distance should be positive or negative
		// 			ray.origin.copy( point );
		// 			ray.direction.set( 0, 0, 1 );
		// 			const hit = bvh.raycastFirst( ray, THREE.DoubleSide );
		// 			const isInside = hit && hit.face.normal.dot( ray.direction ) > 0.0;

		// 			// set the distance in the texture data
		// 			sdfTex.image.data[ index ] = isInside ? - dist : dist;

		// 		}

		// 	}

		// }

	}

	// update the timing display
	const delta = window.performance.now() - startTime;
	outputContainer.innerText = `${ delta.toFixed( 2 ) }ms`;

	rebuildGUI();

}

function render() {

	stats.update();
	requestAnimationFrame( render );

	if ( ! sdfTex ) {

		// render nothing
		return;

	} else if ( params.mode === 'geometry' ) {

		// render the rasterized geometry
		renderer.render( scene, camera );

	} else if ( params.mode === 'layer' || params.mode === 'grid layers' ) {

		// render a layer of the 3d texture
		let tex;
		const material = layerPass.material;
		if ( sdfTex.isData3DTexture ) {

			material.uniforms.layer.value = params.layer / sdfTex.image.width;
			material.uniforms.sdfTex.value = sdfTex;
			tex = sdfTex;

		} else {

			material.uniforms.layer.value = params.layer / sdfTex.width;
			material.uniforms.sdfTex.value = sdfTex.texture;
			tex = sdfTex.texture;

		}

		material.uniforms.layers.value = tex.image.width;

		const gridMode = params.mode === 'layer' ? 0 : 1;
		if ( gridMode !== material.defines.DISPLAY_GRID ) {

			material.defines.DISPLAY_GRID = gridMode;
			material.needsUpdate = true;

		}

		layerPass.render( renderer );

	} else if ( params.mode === 'raymarching' ) {

		// render the ray marched texture
		camera.updateMatrixWorld();
		mesh.updateMatrixWorld();

		let tex;
		if ( sdfTex.isData3DTexture ) {

			tex = sdfTex;

		} else {

			tex = sdfTex.texture;

		}

		const { width, depth, height } = tex.image;
		raymarchPass.material.uniforms.sdfTex.value = tex;
		raymarchPass.material.uniforms.normalStep.value.set( 1 / width, 1 / height, 1 / depth );
		raymarchPass.material.uniforms.surface.value = params.surface;
		raymarchPass.material.uniforms.projectionInverse.value.copy( camera.projectionMatrixInverse );
		raymarchPass.material.uniforms.sdfTransformInverse.value.copy( mesh.matrixWorld ).invert().premultiply( inverseBoundsMatrix ).multiply( camera.matrixWorld );
		raymarchPass.render( renderer );

	}

}


export async function loadAtlasTiledToData3DTexture(
	renderer,
	url,
	{
		sliceW = 64,
		sliceH = 64,
		depth = 64,
		tilesX = 8,
		tilesY = 8,

		// ImageBitmapLoader option you showed:
		imageOrientation = "flipY",

		// How you *index* tiles when you say "top row", "bottom row"
		tileOrigin = undefined, // default: inferred from imageOrientation

		// destination sampling:
		minFilter = THREE.LinearFilter,
		magFilter = THREE.LinearFilter,
	} = {},
) {
	const loader = new THREE.ImageBitmapLoader();
	loader.setOptions({ imageOrientation });
	const bitmap = await loader.loadAsync(url);

	const atlasTex = new THREE.Texture(bitmap);
	atlasTex.flipY = false; // don't double-flip; bitmap already handled
	atlasTex.colorSpace = THREE.NoColorSpace;
	atlasTex.generateMipmaps = false;
	atlasTex.minFilter = THREE.NearestFilter;
	atlasTex.magFilter = THREE.NearestFilter;
	atlasTex.needsUpdate = true;

	// Allocate a 3D texture (data can be null; storage gets created on initTexture) :contentReference[oaicite:1]{index=1}
	const volTex = new THREE.Data3DTexture(null, sliceW, sliceH, depth);
	volTex.format = THREE.RGBAFormat;
	volTex.type = THREE.UnsignedByteType;
	volTex.colorSpace = THREE.NoColorSpace;
	volTex.unpackAlignment = 1;
	volTex.generateMipmaps = false;
	volTex.minFilter = minFilter;
	volTex.magFilter = magFilter;
	volTex.wrapS = volTex.wrapT = volTex.wrapR = THREE.ClampToEdgeWrapping;
	volTex.needsUpdate = true;

	// Ensure both GPU objects exist before copying
	renderer.initTexture(atlasTex);
	renderer.initTexture(volTex); // :contentReference[oaicite:2]{index=2}

	if (depth > tilesX * tilesY) throw new Error("depth exceeds tilesX*tilesY");

	const origin =
		tileOrigin ?? (imageOrientation === "flipY" ? "bottom-left" : "top-left");

	// Reuse objects to avoid GC in the loop
	const srcBox = new THREE.Box3();
	const dstPos = new THREE.Vector3();

	for (let z = 0; z < depth; z++) {
		const tx = z % tilesX;
		const tyRowMajor = (z / tilesX) | 0;

		const ty = origin === "top-left" ? tilesY - 1 - tyRowMajor : tyRowMajor;

		const x0 = tx * sliceW;
		const y0 = ty * sliceH;

		srcBox.min.set(x0, y0, 0);
		srcBox.max.set(x0 + sliceW, y0 + sliceH, 1); // depth=1 slab in src
		dstPos.set(0, 0, z);

		renderer.copyTextureToTexture(atlasTex, volTex, srcBox, dstPos, 0, 0); // :contentReference[oaicite:3]{index=3}
	}

	bitmap.close?.(); // optional
	// atlasTex.dispose(); // optional once you're done with the atlas

	return volTex;
}



/**
 * Convert a 2D atlas (slices tiled in a grid) into a THREE.Data3DTexture.
 * Assumes slices are ordered row-major: z = ty*tilesX + tx, starting at top-left tile.
 */
export function atlasToData3DTexture(
	imageLike,
	{
		sliceW = 64,
		sliceH = 64,
		depth = 64,
		tilesX = 8,
		tilesY = 8,
		flipSliceY = false, // flip Y *within each slice* while copying (if your atlas is bottom-up)
		format = THREE.RedFormat,
		type = THREE.FloatType,
		// colorSpace = THREE.NoColorSpace, // use SRGBColorSpace only if this is actually color data
	} = {},
) {
	const atlasW = tilesX * sliceW;
	const atlasH = tilesY * sliceH;

	console.time("full");
	// Draw into canvas to read pixels
	const canvas = document.createElement("canvas");
	canvas.width = atlasW;
	canvas.height = atlasH;
	const ctx = canvas.getContext("2d", { willReadFrequently: true });

	console.time("draw");
	// If the source image isn't exactly atlasW/H, drawImage scales; you probably want exact match.
	ctx.drawImage(imageLike, 0, 0, atlasW, atlasH);
	console.timeEnd("draw");

	const src = ctx.getImageData(0, 0, atlasW, atlasH).data; // Uint8ClampedArray RGBA
	const dst = new Float32Array(sliceW * sliceH * depth * 4);

	console.time("copy");
	for (let z = 0; z < depth; z++) {
		const tx = z % tilesX;
		const ty = (z / tilesX) | 0;
		if (ty >= tilesY)
			throw new Error(
				`depth=${depth} exceeds tilesX*tilesY=${tilesX * tilesY}`,
			);

		const baseX = tx * sliceW;
		const baseY = ty * sliceH;

		for (let y = 0; y < sliceH; y++) {
			const yy = flipSliceY ? sliceH - 1 - y : y;
			const srcRow = (baseY + yy) * atlasW;
			const dstRow = y * sliceW;

			for (let x = 0; x < sliceW; x++) {
				const si = ((srcRow + (baseX + x)) * 4) | 0;
				const di = ((z * sliceW * sliceH + (dstRow + x)) * 4) | 0;

				dst[di + 0] = src[si + 0] / 256;
				dst[di + 1] = src[si + 1] / 256;
				dst[di + 2] = src[si + 2] / 256;
				dst[di + 3] = src[si + 3] / 256;
			}
		}
	}
	console.timeEnd("copy");

	const tex3d = new THREE.Data3DTexture(dst, sliceW, sliceH, depth);
	tex3d.format = format;
	tex3d.type = type;
	tex3d.magFilter = THREE.LinearFilter;
	tex3d.minFilter = THREE.LinearFilter;
	// tex3d.colorSpace = colorSpace;

	// Defaults for Data3DTexture are already sensible for voxel-ish data (no mips, nearest). :contentReference[oaicite:2]{index=2}
	tex3d.wrapS = tex3d.wrapT = tex3d.wrapR = THREE.ClampToEdgeWrapping;
	tex3d.unpackAlignment = 1;
	tex3d.needsUpdate = true;
	console.timeEnd("full");

	return tex3d;
}

// // Efficient distance decode: rawPixel (0..255 from R channel) -> float = raw*scale + minDistance
// // meta JSON: <url_without_ext>.json  e.g. {"edgeLen":16,"minDistance":...,"maxDistance":...}

// // const _stripExt = (u) => u.replace(/(\.[^./?]+)(\?.*)?$/, "$2"); // keeps ?query
// const metaUrlFromImageUrl = (imgUrl) => {
// 	const q = imgUrl.indexOf("?");
// 	const base = q >= 0 ? imgUrl.slice(0, q) : imgUrl;
// 	const query = q >= 0 ? imgUrl.slice(q) : "";
// 	const noExt = base.replace(/\.[^./]+$/, "");
// 	return noExt + ".json" + query;
// };

// export class DistanceFieldDecoder {
// 	constructor() {
// 		this.canvas = new OffscreenCanvas(1, 1);
// 		this.ctx = this.canvas.getContext("2d", {
// 			alpha: true,
// 			willReadFrequently: true,
// 		});
// 		if (!this.ctx) throw new Error("2D context unavailable");
// 	}

// 	/**
// 	 * @param {string} imgUrl - image URL (png/jpg/...)
// 	 * @returns {Promise<{distances: Float32Array, width:number, height:number, edgeLen?:number, minDistance:number, maxDistance:number}>}
// 	 */
// 	async decode(imgUrl) {
// 		const jsonUrl = metaUrlFromImageUrl(imgUrl);

// 		const [imgBlob, meta] = await Promise.all([
// 			fetch(imgUrl).then((r) => {
// 				if (!r.ok)
// 					throw new Error(`Image fetch failed: ${r.status} ${r.statusText}`);
// 				return r.blob();
// 			}),
// 			fetch(jsonUrl).then((r) => {
// 				if (!r.ok)
// 					throw new Error(`Meta fetch failed: ${r.status} ${r.statusText}`);
// 				return r.json();
// 			}),
// 		]);

// 		// Avoid extra color conversions when supported (harmless if ignored by browser).
// 		const bmp = await createImageBitmap(imgBlob, {
// 			premultiplyAlpha: "none",
// 			colorSpaceConversion: "none",
// 			imageOrientation: "none",
// 		});

// 		const w = bmp.width,
// 			h = bmp.height;

// 		// Reuse the same OffscreenCanvas; resize only when needed.
// 		if (this.canvas.width !== w) this.canvas.width = w;
// 		if (this.canvas.height !== h) this.canvas.height = h;

// 		const ctx = this.ctx;
// 		ctx.clearRect(0, 0, w, h);
// 		ctx.drawImage(bmp, 0, 0);

// 		// Uint8ClampedArray RGBA
// 		const data = ctx.getImageData(0, 0, w, h).data;

// 		const minDistance = meta.minDistance;
// 		const maxDistance = meta.maxDistance;
// 		const scale = (maxDistance - minDistance) / 255.0; // fold normalization into scale
// 		const out = new Float32Array(meta.edgeLen ** 3);

// 		// Fast tight loop: R channel only (common for single-channel distance textures).
// 		for (let di = 0; di < out.length; di++) {
// 			out[di] = data[di % meta.edgeLen ] * scale + minDistance;
// 		}

// 		return {
// 			distances: out,
// 			width: w,
// 			height: h,
// 			edgeLen: meta.edgeLen,
// 			minDistance,
// 			maxDistance,
// 		};
// 	}
// }

// /* Worker-friendly usage (transfer the backing buffer):
// const decoder = new DistanceFieldDecoder();
// self.onmessage = async (e) => {
//   const { url } = e.data;
//   const res = await decoder.decode(url);
//   self.postMessage(
//     { ...res, distances: res.distances.buffer },
//     [res.distances.buffer]
//   );
// };
// */
export class SdfAtlasDecoder {
  constructor() {
    this.canvas = new OffscreenCanvas(1, 1);
    this.ctx = this.canvas.getContext("2d", { alpha: false, willReadFrequently: true });
    if (!this.ctx) throw new Error("2D context unavailable");
  }

  async decode(imgUrl) {
    const jsonUrl = (() => {
      const q = imgUrl.indexOf("?");
      const base = q >= 0 ? imgUrl.slice(0, q) : imgUrl;
      const query = q >= 0 ? imgUrl.slice(q) : "";
      return base.replace(/\.[^./]+$/, "") + ".json" + query;
    })();

    const [imgBlob, meta] = await Promise.all([
      fetch(imgUrl).then(r => { if (!r.ok) throw new Error(`Image fetch failed: ${r.status}`); return r.blob(); }),
      fetch(jsonUrl).then(r => { if (!r.ok) throw new Error(`Meta fetch failed: ${r.status}`); return r.json(); }),
    ]);

    const bmp = await createImageBitmap(imgBlob, {
      premultiplyAlpha: "none",
      colorSpaceConversion: "none",
      imageOrientation: "none",
    });

    const width = bmp.width, height = bmp.height;
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;

    const ctx = this.ctx;
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(bmp, 0, 0);
    bmp.close?.();

    const edgeLen = meta.edgeLen | 0;
    const min = meta.minDistance;
    const max = meta.maxDistance;
    const denom = max - min;

    if ((width % edgeLen) || (height % edgeLen)) {
      throw new Error(`Image size (${width}x${height}) not divisible by edgeLen=${edgeLen}`);
    }
    const tilesX = (width / edgeLen) | 0;
    const tilesY = (height / edgeLen) | 0;

    const data = ctx.getImageData(0, 0, width, height).data; // Uint8ClampedArray RGBA

    // LUT: g -> d
    const lut = new Float32Array(256);
    const scale = denom / 255.0;
    for (let g = 0; g < 256; g++) lut[g] = g/255*0.8;// * scale + min;

    const sliceLen = edgeLen * edgeLen;
    const out = new Float32Array(edgeLen * sliceLen);

    for (let z = 0; z < edgeLen; z++) {
      const tileX = z % tilesX;
      const tileY = (z / tilesX) | 0;
      if (tileY >= tilesY) throw new Error(`Not enough tiles for z=${z}`);

      const baseX = tileX * edgeLen;
      const baseY = tileY * edgeLen;

      const sliceOff = z * sliceLen;

      for (let y = 0; y < edgeLen; y++) {
        let outIdx = sliceOff + y * edgeLen;

        // byte index to R of first pixel in this row
        let si = (((baseY + y) * width + baseX) << 2); // *4

        // inner loop: read R only; grayscale => R==G==B
        for (let x = 0; x < edgeLen; x++) {
          out[outIdx + x] = lut[data[si]];
          si += 4;
        }
      }
    }

    return { distances: out, edgeLen, minDistance: min, maxDistance: max, width, height };
  }
}
