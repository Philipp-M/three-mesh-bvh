import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GUI } from 'three/examples/jsm/libs/lil-gui.module.min.js';
import Stats from 'stats.js';
import { GenerateMeshBVHWorker } from '../src/workers/GenerateMeshBVHWorker.js';
import { StaticGeometryGenerator } from '..';
import { GenerateSDFMaterial } from './utils/GenerateSDFMaterial.js';
import { RenderSDFLayerMaterial } from './utils/RenderSDFLayerMaterial.js';
import { RayMarchSDFMaterial } from './utils/RayMarchSDFMaterial.js';
import { RayMarchSDF2Material } from './utils/RayMarchSDF2Material.js';
import { BVHShaderGLSL, MeshBVHUniformStruct } from '..';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';

const params = {

	gpuGeneration: true,
	resolution: 75,
	resolutionScale: 0.1,
	crossFade: 0.5,
	heatMapRange: 1.0,
	margin: 0.2,
	regenerate: () => updateSDF(),

	// mode: 'raymarchingField',
	mode: 'geometry',
	layer: 0,
	surface: 0.1,

};

let renderer, camera, scene, gui, stats, boxHelper;
let outputContainer, bvh, geometry, sdfTex, mesh;
let generateSdfPass, layerPass, raymarchFieldPass, raymarchPass;
let bvhGenerationWorker;
const inverseBoundsMatrix = new THREE.Matrix4();
const matrix = new THREE.Matrix4();

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

	const orbit = new OrbitControls(camera, renderer.domElement);
	const controls = new TransformControls(camera, renderer.domElement);
	controls.addEventListener("dragging-changed", function (event) {
		console.log(event);
		orbit.enabled = !event.value;
	});

	// stats setup
	stats = new Stats();
	document.body.appendChild( stats.dom );

	// sdf pass to generate the 3d texture
	generateSdfPass = new FullScreenQuad( new GenerateSDFMaterial() );

	// screen pass to render a single layer of the 3d texture
	layerPass = new FullScreenQuad( new RenderSDFLayerMaterial() );

	// screen pass to render the sdf ray marching
	raymarchFieldPass = new FullScreenQuad( new RayMarchSDFMaterial() );
	raymarchPass = new FullScreenQuad( new RayMarchSDF2Material() );

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

			const mat = new THREE.MeshPhysicalMaterial({
				color: "silver",
				transmission: 0.0001, // Needed such that vWorldPosition is accessible... (There are cleaner ways obviously...)
				metalness: 0.9,
				roughness: 0.1,
				onBeforeCompile: (shader) => {

					shader.uniforms.crossFade = mat.userData.uniforms.crossFade;
					shader.uniforms.bvh = mat.userData.uniforms.bvh;
					shader.uniforms.heatMapRange = mat.userData.uniforms.heatMapRange;

				 	shader.fragmentShader = `
				 		uniform float crossFade;
				 		uniform float heatMapRange;
						${BVHShaderGLSL.common_functions}
						${BVHShaderGLSL.bvh_struct_definitions}
						${BVHShaderGLSL.bvh_ray_functions}
						${BVHShaderGLSL.bvh_distance_functions}
						uniform BVH bvh;

						vec3 heatMap(float greyValue) {
							vec3 heat;
							heat.r = smoothstep(0.5, 0.8, greyValue);
							if(greyValue >= 0.90) {
								heat.r *= (1.1 - greyValue) * 5.0;
							}
							if(greyValue > 0.7) {
								heat.g = smoothstep(1.0, 0.7, greyValue);
							} else {
								heat.g = smoothstep(0.0, 0.7, greyValue);
							}
							heat.b = smoothstep(1.0, 0.0, greyValue);
								if(greyValue <= 0.3) {
									heat.b *= greyValue / 0.3;
								}
							return heat;
						}
					 ${shader.fragmentShader}
				 `.replace(
						`#include <dithering_fragment>`,
						`#include <dithering_fragment>
	
						// retrieve the distance and other values
						uvec4 faceIndices;
						vec3 faceNormal;
						vec3 barycoord;
						float side;
						float rayDist;
						vec3 outPoint;
						float dist = bvhClosestPointToPoint( bvh, vWorldPosition.xyz, 100000.0, faceIndices, faceNormal, barycoord, side, outPoint );
						vec3 nColor = heatMap(clamp(dist / heatMapRange, 0.0, 1.0));
						gl_FragColor.rgb = mix(gl_FragColor.rgb, nColor, crossFade);
				 `,
					);
				},
			});
			// mat.uniforms.bvvh.value.updateFrom( bvh );
			const bvhUniform = new MeshBVHUniformStruct();
			bvhUniform.updateFrom(bvh);
			mat.userData = {
				uniforms: {
				 	crossFade: {value: 0.5},
				 	heatMapRange: {value: 1.0},
					bvh: { value: bvhUniform }
				}
			};
			mesh = new THREE.Mesh( geometry, mat );			scene.add( mesh );
			controls.attach( mesh );
			const gizmo = controls.getHelper();
			scene.add( gizmo );

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
	generationFolder.add( params, 'resolution', 10, 1000, 1 );
	generationFolder.add( params, 'margin', 0, 1 );
	generationFolder.add( params, 'regenerate' );

	const displayFolder = gui.addFolder( 'display' );
	displayFolder.add( params, 'mode', [ 'geometry', 'raymarchingField', 'raymarching', 'layer', 'grid layers' ] ).onChange( () => {

		rebuildGUI();

	} );
	if ( params.mode === 'geometry' ) {
		displayFolder.add( params, 'crossFade', 0.0, 1.0 );
		displayFolder.add( params, 'heatMapRange', 0.1, 20.0 );
	}

	if ( params.mode === 'layer' ) {

		displayFolder.add( params, 'layer', 0, params.resolution, 1 );

	}

	if ( params.mode === 'raymarchingField' || params.mode === 'raymarching' ) {

		displayFolder.add( params, 'surface', - 0.2, 0.5 );

	}

	if ( params.mode === 'raymarching' ) {

		displayFolder.add( params, 'resolutionScale', 0.01, 1.0 );

	}

}

// update the sdf texture based on the selected parameters
function updateSDF() {

	const dim = params.resolution;
	// const matrix = new THREE.Matrix4();
	const center = new THREE.Vector3();
	const quat = new THREE.Quaternion();
	const scale = new THREE.Vector3();

	// compute the bounding box of the geometry including the margin which is used to
	// define the range of the SDF
	geometry.boundingBox.getCenter( center );
	scale.subVectors( geometry.boundingBox.max, geometry.boundingBox.min );
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

		// create a new 3d data texture
		sdfTex = new THREE.Data3DTexture( new Float32Array( dim ** 3 ), dim, dim, dim );
		sdfTex.format = THREE.RedFormat;
		sdfTex.type = THREE.FloatType;
		sdfTex.minFilter = THREE.LinearFilter;
		sdfTex.magFilter = THREE.LinearFilter;
		sdfTex.needsUpdate = true;

		const point = new THREE.Vector3();
		const ray = new THREE.Ray();
		const target = {};

		// iterate over all pixels and check distance
		for ( let x = 0; x < dim; x ++ ) {

			for ( let y = 0; y < dim; y ++ ) {

				for ( let z = 0; z < dim; z ++ ) {

					// adjust by half width of the pixel so we sample the pixel center
					// and offset by half the box size.
					point.set(
						halfWidth + x * pxWidth - 0.5,
						halfWidth + y * pxWidth - 0.5,
						halfWidth + z * pxWidth - 0.5,
					).applyMatrix4( matrix );

					const index = x + y * dim + z * dim * dim;
					const dist = bvh.closestPointToPoint( point, target ).distance;

					// raycast inside the mesh to determine if the distance should be positive or negative
					ray.origin.copy( point );
					ray.direction.set( 0, 0, 1 );
					const hit = bvh.raycastFirst( ray, THREE.DoubleSide );
					const isInside = hit && hit.face.normal.dot( ray.direction ) > 0.0;

					// set the distance in the texture data
					sdfTex.image.data[ index ] = isInside ? - dist : dist;

				}

			}

		}

	}

	// update the timing display
	const delta = window.performance.now() - startTime;
	outputContainer.innerText = `${ delta.toFixed( 2 ) }ms`;

	rebuildGUI();

}

function render() {

	stats.update();
	requestAnimationFrame( render );

	const dpr = window.devicePixelRatio;
	renderer.setPixelRatio( dpr );

	if ( ! sdfTex ) {

		// render nothing
		return;

	} else if ( params.mode === 'geometry' ) {

		mesh.material.userData.uniforms.bvh.value.updateFrom( bvh );
		mesh.material.userData.uniforms.crossFade.value = params.crossFade;
		mesh.material.userData.uniforms.heatMapRange.value = params.heatMapRange;
		// console.log(mesh.material.uniforms, layerPass.material.uniforms);
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

	} else if ( params.mode === 'raymarchingField' ) {

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
		raymarchFieldPass.material.uniforms.sdfTex.value = tex;
		raymarchFieldPass.material.uniforms.normalStep.value.set( 1 / width, 1 / height, 1 / depth );
		raymarchFieldPass.material.uniforms.surface.value = params.surface;
		raymarchFieldPass.material.uniforms.projectionInverse.value.copy( camera.projectionMatrixInverse );
		raymarchFieldPass.material.uniforms.sdfTransformInverse.value.copy( mesh.matrixWorld ).invert().premultiply( inverseBoundsMatrix ).multiply( camera.matrixWorld );
		raymarchFieldPass.render( renderer );

	} else if (params.mode === 'raymarching') {

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
		raymarchPass.material.uniforms.bvh.value.updateFrom( bvh );
		raymarchPass.material.uniforms.sdfTex.value = tex;
		raymarchPass.material.uniforms.normalStep.value.set( 1 / width, 1 / height, 1 / depth );
		raymarchPass.material.uniforms.surface.value = params.surface;
		raymarchPass.material.uniforms.projectionInverse.value.copy( camera.projectionMatrixInverse );
		raymarchPass.material.uniforms.sdfTransformInverse.value.copy( mesh.matrixWorld ).invert().premultiply( inverseBoundsMatrix ).multiply( camera.matrixWorld );
		raymarchPass.material.uniforms.matrix.value.copy( matrix );
		const dpr = window.devicePixelRatio * params.resolutionScale;
		renderer.setPixelRatio( dpr );
		raymarchPass.render( renderer );

	}

}
