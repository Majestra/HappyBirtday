let scene, camera, renderer, controls;
let boxModel, roomModel;
let mixer;
let boxActions = [];
let isOpened = false;
let openDurationMs = 1500; // запасне значення, перерахується з реальної довжини анімації

// Оголошуємо годинник на самому початку, щоб уникнути помилок ініціалізації
const clock = new THREE.Clock();

init();
animate();

function init() {
    // 1. Сцена, камера, рендерер
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0b0b1a);

    camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.set(0, 3, 6);

    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(window.devicePixelRatio);

    // Головні налаштування для точної передачі кольорів та матеріалів з Blender
    renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;

    // Тіні — без цього моделі виглядають "пласкими"
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    document.body.appendChild(renderer.domElement);

    // 2. Орбітальне управління мишкою
    controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.target.set(0, 1, 0);

    // 3. Освітлення
    // Жодна з моделей (Box.glb / Room.glb) не містить власних джерел світла,
    // тож будуємо невелику схему замість одного ambient-світла.
    // ВАЖЛИВО: інтенсивності тут навмисно низькі — кілька світел сумуються
    // одне з одним, і навіть невеликі значення разом дають повне експонування.

    // М'яке заповнювальне світло неба/підлоги (усуває чорні тіні там, де немає прямого світла)
    const hemiLight = new THREE.HemisphereLight(0xbfd4ff, 0x2b2117, 0.3);
    scene.add(hemiLight);

    // Дуже невеликий загальний ambient, щоб тіні не були зовсім чорними
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.1);
    scene.add(ambientLight);

    // Головне (key) світло — з тінями. Це основне освітлення для коробки
    // (Box.glb не містить власного світла навіть після переекспорту).
    const keyLight = new THREE.DirectionalLight(0xfff4e0, 0.7);
    keyLight.position.set(4, 6, 4);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.set(2048, 2048);
    keyLight.shadow.camera.near = 0.5;
    keyLight.shadow.camera.far = 30;
    keyLight.shadow.camera.left = -8;
    keyLight.shadow.camera.right = 8;
    keyLight.shadow.camera.top = 8;
    keyLight.shadow.camera.bottom = -8;
    keyLight.shadow.bias = -0.0005;
    scene.add(keyLight);

    // Заповнювальне (fill) світло з протилежного боку, слабше і без тіней
    const fillLight = new THREE.DirectionalLight(0xcfe8ff, 0.25);
    fillLight.position.set(-5, 3, -3);
    scene.add(fillLight);

    // Контрове (rim) світло позаду для легкого відділення об'єкта від фону
    const rimLight = new THREE.DirectionalLight(0xffffff, 0.2);
    rimLight.position.set(0, 4, -6);
    scene.add(rimLight);

    const loader = new THREE.GLTFLoader();

    // 4. Завантаження моделі кімнати (Room.glb)
    loader.load('Room.glb', function (gltf) {
        roomModel = gltf.scene;
        roomModel.visible = false; // Ховаємо кімнату до відкриття коробки
        enableShadows(roomModel);
        tuneImportedLights(roomModel);
        fixTextMaterial(roomModel);
        scene.add(roomModel);
        console.log('Кімната успішно завантажена!');
    }, undefined, function (error) {
        console.error('Помилка завантаження кімнати Room.glb:', error);
    });

    // 5. Завантаження моделі коробки (Box.glb)
    loader.load('Box.glb', function (gltf) {
        boxModel = gltf.scene;
        boxModel.scale.set(1, 1, 1);
        enableShadows(boxModel);
        scene.add(boxModel);
        console.log('Коробка успішно завантажена!');

        // У Box.glb анімація коробки розбита на ОКРЕМІ кліпи для кожної частини
        // (дно, 4 стінки, частини подарунка). Треба програти ЇХ УСІ одночасно,
        // інакше рухається лише перша деталь, а решта стоїть на місці.
        if (gltf.animations && gltf.animations.length > 0) {
            mixer = new THREE.AnimationMixer(boxModel);

            let maxDuration = 0;
            gltf.animations.forEach((clip) => {
                const action = mixer.clipAction(clip);
                action.setLoop(THREE.LoopOnce, 1);
                action.clampWhenFinished = true;
                boxActions.push(action);
                if (clip.duration > maxDuration) maxDuration = clip.duration;
            });

            // Синхронізуємо появу конфетті/кімнати з реальною тривалістю анімації
            openDurationMs = Math.max(maxDuration * 1000, 300);

            console.log(`Знайдено та підключено ${boxActions.length} анімаційних кліпів коробки (тривалість ~${maxDuration.toFixed(2)}с).`);
        } else {
            console.warn('У файлі Box.glb не знайдено жодної анімації!');
        }
    }, undefined, function (error) {
        console.error('Помилка завантаження коробки Box.glb:', error);
    });

    // 6. Слухачі подій
    window.addEventListener('click', onClickOpen);
    window.addEventListener('resize', onWindowResize);
}

// Вмикає відкидання/прийом тіней для всіх мешів моделі
function enableShadows(root) {
    root.traverse((node) => {
        if (node.isMesh) {
            node.castShadow = true;
            node.receiveShadow = true;
        }
    });
}

// Blender експортує інтенсивність світла в "сирих" канделах (напр. 8000+),
// що для three.js є нереалістично яскравим значенням і засвічує сцену.
// Тому беремо позицію/колір/тип світла з моделі (це і є цінна частина —
// точне розміщення лампи, як у Blender), а інтенсивність підбираємо вручну.
function tuneImportedLights(root) {
    root.traverse((node) => {
        if (node.isLight) {
            console.log(`Знайдено світло з моделі: ${node.type}, оригінальна інтенсивність: ${node.intensity}`);

            if (node.isPointLight) {
                node.intensity = 1.4;
                node.distance = 12;
                node.decay = 2;
            } else if (node.isSpotLight) {
                node.intensity = 1.2;
                node.distance = 15;
            } else if (node.isDirectionalLight) {
                node.intensity = 0.8;
            }

            node.castShadow = true;
            if (node.shadow) {
                node.shadow.mapSize.set(1024, 1024);
                node.shadow.bias = -0.0008;
            }
        }
    });
}

// Матеріал напису "Happy Birthday" ("Metal") у Blender виглядає червоним
// завдяки HDRI-відбиттям у вьюпорті. glTF не експортує ці відбиття, а без
// вказаного metallicFactor матеріал за замовчуванням стає 100% металевим —
// без environment-карти такий метал рендериться майже чорним. Виправляємо
// вручну: робимо його неметалевим і додаємо власне легке світіння (neon).
function fixTextMaterial(root) {
    root.traverse((node) => {
        if (!node.isMesh) return;

        const materials = Array.isArray(node.material) ? node.material : [node.material];
        materials.forEach((mat) => {
            if (mat && mat.name === 'Metal') {
                mat.metalness = 0;
                mat.roughness = Math.min(mat.roughness ?? 0.5, 0.4);
                mat.emissive = new THREE.Color(0xff1a4d);
                mat.emissiveIntensity = 0.9;
                mat.needsUpdate = true;
                console.log('Матеріал "Metal" (напис) виправлено: metalness=0, додано світіння.');
            }
        });
    });
}

// Функція відкриття по кліку
function onClickOpen() {
    if (isOpened) return;

    if (boxActions.length > 0) {
        isOpened = true;
        document.getElementById('instructions').style.display = 'none';

        // Запускаємо ВСІ кліпи анімації коробки одночасно
        boxActions.forEach((action) => {
            action.reset();
            action.play();
        });
        console.log('Анімація коробки запущена!');

        // Таймер для конфетті та показу кімнати — підлаштований під реальну довжину анімації
        setTimeout(() => {
            confetti({
                particleCount: 150,
                spread: 100,
                origin: { y: 0.6 }
            });

            if (roomModel) roomModel.visible = true;
            if (boxModel) boxModel.visible = false; // Ховаємо шматки коробки після розльоту

            // Невелика пауза після феєрверку, щоб напис з'явився вже над відкритою кімнатою
            setTimeout(showBirthdayMessage, 600);
        }, openDurationMs);
    } else {
        console.warn('Анімація ще не завантажилася або її немає.');
    }
}

// Показує привітальний напис над кімнатою та запускає плаваючі сердечка
function showBirthdayMessage() {
    const messageEl = document.getElementById('birthday-message');
    if (!messageEl) return;

    messageEl.classList.add('show');

    // Друга хвиля конфеті — легша, для акценту на моменті появи напису
    confetti({
        particleCount: 60,
        spread: 70,
        scalar: 0.8,
        origin: { y: 0.3 }
    });

    // Плаваючі сердечка, що злітають знизу вгору навколо напису
    const heartEmojis = ['❤️', '💖', '💕', '✨'];
    const spawnHeart = () => {
        const heart = document.createElement('div');
        heart.className = 'floating-heart';
        heart.textContent = heartEmojis[Math.floor(Math.random() * heartEmojis.length)];
        heart.style.left = (45 + Math.random() * 10) + '%';
        heart.style.setProperty('--drift', (Math.random() * 80 - 40) + 'px');
        heart.style.top = (25 + Math.random() * 10) + '%';
        document.body.appendChild(heart);
        setTimeout(() => heart.remove(), 4600);
    };

    let spawned = 0;
    const heartInterval = setInterval(() => {
        spawnHeart();
        spawned++;
        if (spawned >= 18) clearInterval(heartInterval);
    }, 250);
}

// Анімаційний цикл
function animate() {
    requestAnimationFrame(animate);

    const delta = clock.getDelta();
    if (mixer) {
        mixer.update(delta);
    }

    controls.update();
    renderer.render(scene, camera);
}

// Адаптивність при зміні розміру вікна браузера
function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}