import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';
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
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree, MeshBVHHelper } from '..';

THREE.Mesh.prototype.raycast = acceleratedRaycast;
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;

const params = {

	gpuGeneration: true,
	resolution: 75,
	resolutionScale: 0.1,
	opacityGeometry: 1.0,
	opacityPointcloud: 1.0,
	heatMapRangeGeometry: 0.01,
	heatMapRangePointcloud: 0.4,
	margin: 0.2,
	regenerate: () => updateSDF(),

	// mode: 'raymarchingField',
	mode: 'geometry',
	controls: 'pointcloud',
	layer: 0,
	surface: 0.1,

};

let renderer, camera, scene, gui, stats, boxHelper;
let outputContainer, bvh, geometry, sdfTex, mesh, pointCloud, bvhMesh, helper, meshSDFControls, pcSDFControls;
let generateSdfPass, layerPass, raymarchFieldPass, raymarchPass;
let bvhGenerationWorker;
const inverseBoundsMatrix = new THREE.Matrix4();
const matrix = new THREE.Matrix4();
const plyPath = '/bunny/bunny/data/bun000.ply';


const heatMapFragment = `
vec4 heatMap(float greyValue) {
	vec4 heat;

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
		heat.a = heat.b;
	} else {
		heat.a = 1.0;
	}
	return heat;
}
`;


init();
render();

function createTransformControls(object, scene, camera, orbit) {
	const controls = new TransformControls(camera, renderer.domElement);
	controls.addEventListener("dragging-changed", function (event) {
		console.log(event);
		orbit.enabled = !event.value;
	});
	window.addEventListener("keydown", function (event) {
		switch (event.key) {
			case "q":
				controls.setSpace(controls.space === "local" ? "world" : "local");
				break;

			case "Shift":
				controls.setTranslationSnap(1);
				controls.setRotationSnap(THREE.MathUtils.degToRad(15));
				controls.setScaleSnap(0.25);
				break;

			case "w":
				controls.setMode("translate");
				break;

			case "e":
				controls.setMode("rotate");
				break;

			case "r":
				controls.setMode("scale");
				break;
			case "+":
			case "=":
				controls.setSize(controls.size + 0.1);
				break;

			case "-":
			case "_":
				controls.setSize(Math.max(controls.size - 0.1, 0.1));
				break;

			case "x":
				controls.showX = !controls.showX;
				break;

			case "y":
				controls.showY = !controls.showY;
				break;

			case "z":
				controls.showZ = !controls.showZ;
				break;

			case " ":
				controls.enabled = !controls.enabled;
				break;

			case "Escape":
				controls.reset();
				break;
		}
	});

	window.addEventListener("keyup", function (event) {
		switch (event.key) {
			case "Shift":
				controls.setTranslationSnap(null);
				controls.setRotationSnap(null);
				controls.setScaleSnap(null);
				break;
		}
	});
	controls.attach( object );
	const gizmo = controls.getHelper();
	scene.add( gizmo );
	return controls;
}

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
	mesh


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

	const loader = new PLYLoader();
	loader
		.load( plyPath, geom => {

			geom.center();
			const material = new THREE.PointsMaterial( {
				size: 0.01,
				transparent: true,
				// depthTest: false,
				onBeforeCompile: (shader) => {
					shader.uniforms.bvh = material.userData.uniforms.bvh;
					shader.uniforms.heatMapRangePointcloud = material.userData.uniforms.heatMapRangePointcloud;
					shader.vertexShader = `
						varying vec3 vWorldPosition;
						${shader.vertexShader}
						`.replace(
						`#include <worldpos_vertex>`,
						`vec4 worldPosition = vec4( transformed, 1.0 );

						#ifdef USE_BATCHING

							worldPosition = batchingMatrix * worldPosition;

						#endif

						#ifdef USE_INSTANCING

							worldPosition = instanceMatrix * worldPosition;

						#endif

						worldPosition = modelMatrix * worldPosition;
						vWorldPosition = worldPosition.xyz;
						`,
					);
				 	shader.fragmentShader = `
						${BVHShaderGLSL.common_functions}
						${BVHShaderGLSL.bvh_struct_definitions}
						${BVHShaderGLSL.bvh_ray_functions}
						${BVHShaderGLSL.bvh_distance_functions}

				 		uniform float heatMapRangePointcloud;
						uniform BVH bvh;
						varying vec3 vWorldPosition;

						${heatMapFragment}
					  ${shader.fragmentShader}
				 `.replace(
						`#include <premultiplied_alpha_fragment>`,
						`#include <premultiplied_alpha_fragment>
	
						// retrieve the distance and other values
						uvec4 faceIndices;
						vec3 faceNormal;
						vec3 barycoord;
						float side;
						float rayDist;
						vec3 outPoint;
						float dist = bvhClosestPointToPoint( bvh, vWorldPosition.xyz, 100000.0, faceIndices, faceNormal, barycoord, side, outPoint );
						gl_FragColor = heatMap(clamp(abs(dist) / heatMapRangePointcloud, 0.0, 1.0));
						gl_FragColor.a *= opacity;
				 `);
					},
			 } );
			const bvhUniform = new MeshBVHUniformStruct();
			material.userData = {
				uniforms: {
				 	heatMapRangePointcloud: {value: 0.1},
					bvh: { value: bvhUniform }
				}
			};
			pointCloud = new THREE.Points( geom, material );
			pointCloud.scale.multiplyScalar(10.0);
			pointCloud.position.addScalar(0.3);
			console.log(pointCloud.material.userData.uniforms.heatMapRangePointcloud);

			scene.add( pointCloud );
			pcSDFControls = createTransformControls(pointCloud, scene, camera, orbit);
			pcSDFControls.enabled = params.controls === 'pointcloud';
			pcSDFControls.getHelper().visible = params.controls === 'pointcloud';

			// BVH Mesh creation
			const indices = [];
			const bvhGeometry = geom.clone();
			let verticesLength = bvhGeometry.attributes.position.count;
			for ( let i = 0, l = verticesLength; i < l; i ++ ) {

				indices.push( i, i, i );

			}

			bvhGeometry.setIndex( indices );
			const bvhMaterial = new THREE.MeshBasicMaterial( { color: 0xff0000 } );
			bvhMesh = new THREE.Mesh( bvhGeometry, bvhMaterial );
			bvhMesh.scale.multiplyScalar(10.0);

			console.time( 'computeBoundsTree' );
			bvhMesh.geometry.computeBoundsTree( { strategy: params.strategy, maxLeafTris: 1 } );
			console.timeEnd( 'computeBoundsTree' );

			// helper = new MeshBVHHelper( bvhMesh, params.depth );
			// scene.add( helper );
			// console.log("point");
			// scene.add(  new THREE.Mesh( geometry, new THREE.MeshStandardMaterial() ) );
			//
			// bvh = bvhMesh.geometry.boundsTree;

			// bvhGenerationWorker
			// 	.generate(bvhGeometry, { maxLeafTris: 1 })
			// 	.then((result) => {
			// 		bvh = result;
			// 		console.log("yeye");
			// 		// bvhUniform.updateFrom(bvh);
			// 	});
		} );

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
				transmission: 0.0001, // Needed such that vWorldPosition is accessible... (There are cleaner ways obviously...)
				transparent: true,
				// depthTest: false,
				metalness: 0.9,
				roughness: 0.1,
				onBeforeCompile: (shader) => {

					shader.uniforms.bvh = mat.userData.uniforms.bvh;
					shader.uniforms.heatMapRangeGeometry = mat.userData.uniforms.heatMapRangeGeometry;

				 	shader.fragmentShader = `
						${BVHShaderGLSL.common_functions}
						${BVHShaderGLSL.bvh_struct_definitions}
						${BVHShaderGLSL.bvh_ray_functions}
						${BVHShaderGLSL.bvh_distance_functions}

				 		uniform float heatMapRangeGeometry;
						uniform BVH bvh;

						${heatMapFragment}
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
						gl_FragColor = heatMap(clamp(abs(dist) / heatMapRangeGeometry, 0.0, 1.0));
						gl_FragColor.a *= opacity;
				 `,
					);
				},
			});
			// mat.uniforms.bvvh.value.updateFrom( bvh );
			const bvhUniform = new MeshBVHUniformStruct();
			// bvhUniform.updateFrom(bvh);
			mat.userData = {
				uniforms: {
				 	heatMapRangeGeometry: {value: 0.1},
					bvh: { value: bvhUniform }
				}
			};
			// Reference mesh representing SDF
			scene.add( new THREE.Mesh( geometry, new THREE.MeshStandardMaterial({ depthWrite: false }) ) );
			mesh = new THREE.Mesh( geometry, mat );
			scene.add( mesh );
			meshSDFControls = createTransformControls( mesh, scene, camera, orbit );
			meshSDFControls.enabled = params.controls === 'mesh';
			meshSDFControls.getHelper().visible = params.controls === 'mesh';

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
	displayFolder.add( params, 'controls', [ 'pointcloud', 'mesh' ] ).onChange( (c) => {
			pcSDFControls.enabled = c === 'pointcloud';
			pcSDFControls.getHelper().visible = c === 'pointcloud';
			meshSDFControls.enabled = c === 'mesh';
			meshSDFControls.getHelper().visible = c === 'mesh';
	} );
	if ( params.mode === 'geometry' ) {
		displayFolder.add( params, 'opacityGeometry', 0.0, 1.0 );
		displayFolder.add( params, 'opacityPointcloud', 0.0, 1.0 );
		displayFolder.add( params, 'heatMapRangeGeometry', 0.001, 2.0 );
		displayFolder.add( params, 'heatMapRangePointcloud', 0.001, 2.0 );
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
	const scale = new THREE.Vector3(1, 1, 1);

	// compute the bounding box of the geometry including the margin which is used to
	// define the range of the SDF
	// geometry.boundingBox.getCenter( center );
	// scale.subVectors( geometry.boundingBox.max, geometry.boundingBox.min );
	// scale.x += 2 * params.margin;
	// scale.y += 2 * params.margin;
	// scale.z += 2 * params.margin;
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

		pointCloud.material.userData.uniforms.bvh.value.updateFrom( bvh );
		pointCloud.material.userData.uniforms.heatMapRangePointcloud.value = params.heatMapRangePointcloud;
		pointCloud.material.opacity = params.opacityPointcloud;
		mesh.material.userData.uniforms.bvh.value.updateFrom( bvh );
		mesh.material.userData.uniforms.heatMapRangeGeometry.value = params.heatMapRangeGeometry;
		mesh.material.opacity = params.opacityGeometry;
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
