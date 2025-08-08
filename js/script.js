
const dbName = "ESP8266DB";
const storeName = "IPStore";

function initDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(dbName, 1);

        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            if (!db.objectStoreNames.contains(storeName)) {
                db.createObjectStore(storeName, { keyPath: "id" });
            }
        };

        request.onsuccess = (event) => resolve(event.target.result);
        request.onerror = (event) => reject(event.target.error);
    });
}

function getIPFromDB(db) {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(storeName, "readonly");
        const store = transaction.objectStore(storeName);
        const request = store.get("ip");

        request.onsuccess = () => resolve(request.result ? request.result.value : null);
        request.onerror = () => reject(request.error);
    });
}

function saveIPToDB(db, ip) {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(storeName, "readwrite");
        const store = transaction.objectStore(storeName);
        const request = store.put({ id: "ip", value: ip });

        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
}

// Thực hiện GET request
async function fetchJSON(url, protocol = "http") {
    return await reqGET(url, protocol).then(responseText => {
        try {
            return JSON.parse(responseText); // Parse JSON từ responseText
        } catch (error) {
            throw new Error("Failed to parse JSON: " + error.message);
        }
    });
}

async function reqGET(url, protocol = "http") {
    return req(url, protocol, "GET").then(responseText => { return responseText; });
}

function req(url, protocol = "http", med = "GET") {
    return new Promise((resolve, reject) => {
        if (!url.startsWith("http://") && !url.startsWith("https://")) {
            url = `${protocol}://${url}`;
        }

        const xhr = new XMLHttpRequest();
        xhr.open(med, url, true);

        const timeout = setTimeout(() => {
            xhr.abort(); // Hủy request nếu timeout
            reject(new Error("Request timed out"));
        }, 15000); // Timeout sau 15 giây

        xhr.onreadystatechange = function () {
            if (xhr.readyState == 4) {
                clearTimeout(timeout); // Xóa timeout nếu request hoàn thành
                if (xhr.status == 200) {
                    resolve(xhr.responseText); // Trả về text từ response
                } else {
                    ErrorResponse(url); // Hiển thị thông báo lỗi
                    reject(new Error(`HTTP error! status: ${xhr.status}`));
                }
            }
        };

        xhr.onerror = function () {
            clearTimeout(timeout); // Xóa timeout nếu có lỗi mạng
            reject(new Error("Network error"));
        };

        xhr.send();
    }).catch((error) => {
        if (error.message === "Request timed out" || error.message === "Network error") {
            console.warn("Retrying request due to:", error.message);
            // redo
            return req(url, protocol, med);
        }
        throw error;
    });
}

function waitResponse() {
    const container = document.getElementById("buttons-container");
    container.innerHTML = `
        <div class="loading-animation">
            <div class="dot"></div>
            <div class="dot"></div>
            <div class="dot"></div>
        </div>
    `;
}
function ErrorResponse(url) {
    const container = document.getElementById("buttons-container");
    container.innerHTML = `
        <div class="error-animation">
            <div class="error-icon">✖</div>
            <p>Failed to load data. Please check your Server IP.</p>
            ${url && url.trim() !== "" ? `<button id="check-privacy">Or Check Privacy Here !</button>` : ""}
        </div>
    `;

    if (url && url.trim() !== "") {
        // hostname
        var parse = document.createElement('a');
        parse.href = url;
        document.getElementById("check-privacy").addEventListener("click", () => { window.open(parse.origin, "_blank"); });
    }
}

// Xây dựng các nút từ dữ liệu JSON
function buildButtons(data, ip) {
    const container = document.getElementById("buttons-container");

    let listBut = "";
    Object.keys(data).forEach((key) => {
        listBut += `<h4>PC #${+(data[key].idx) + 1} - GPIO ${data[key].GPIO}</h4><button id="${data[key].idx}" class="${data[key].stat}">`;
    });
    container.innerHTML = listBut;

    container.querySelectorAll("button").forEach((button) => {
        button.addEventListener("click", async (e) => {
            if (button.classList.contains("up")) {
                const confirmShutdown = confirm("Do you want to shutdown PC?");
                if (!confirmShutdown) return;
            }
            await reqGET(`${ip}/pw?relay=${e.target.id}`);
            setTimeout(() => getStat(ip), 1000);
        });
    });
    
}

// Tải và hiển thị các nút
async function getStat(ip) {
    try {
        waitResponse();
        const data = await fetchJSON(`${ip}/stt`);
        console.log(data);
        buildButtons(data, ip);
    } catch (error) {
        console.error("Error fetching data:", error);
    }
}

// Khởi chạy ứng dụng
(async function () {
    const db = await initDB();
    let ip = await getIPFromDB(db);

    const ipInput = document.getElementById("ipserver");
    if (ip) {
        ipInput.value = ip;
        getStat(ip);
    }

    ipInput.addEventListener("change", async () => {
        ip = ipInput.value;
        await saveIPToDB(db, ip);
        getStat(ip);
    });

    document.getElementById("saveip").addEventListener("click", async () => {
        const ipInput = document.getElementById("ipserver");
        const ip = ipInput.value.trim();
    
        if (!ip) {
            alert("Please enter a valid IP address.");
            return;
        }
    
        try {
            const db = await initDB();
            await saveIPToDB(db, ip); // Lưu IP vào IndexedDB
            getStat(ip); // Thực hiện GET tới '/stt' và xây dựng các nút
        } catch (error) {
            console.error("Error fetching status or saving IP:", error);
        }
    });

})();