import socketio
import signal, sys, time, requests
from concurrent.futures import ThreadPoolExecutor
import configparser

config = configparser.ConfigParser()
config.read('./config.ini')
IP = config['DEFAULT']['IP']
filaID = config['DEFAULT']['filaID']
fila = config['DEFAULT']['fila']
targetUrl = config['DEFAULT']['targetUrl']
layoutVersion = config['DEFAULT']['layoutVersion']
proxy = config['DEFAULT']['proxy']

multitasking = int(input("Cantidad de procesos simultáneos: "))

def procesar(fila_data):
 
    ticketId = fila_data.get("ticketId")
    cookies = fila_data.get("cookies", [])
    
    if not ticketId or not cookies:
        print(f"❌ Datos insuficientes para procesar fila: {ticketId}")
        return {"ticketId": ticketId, "status": "error", "error": "Datos insuficientes"}
    
    try:
        cookie_string = "; ".join([f"{cookie['name']}={cookie['value']}" for cookie in cookies])
        
        payload = {
            "targetUrl": str(targetUrl),
            "customUrlParams": "",
            "layoutVersion": int(layoutVersion),
            "layoutName": "Boca Socios",
            "isClientRedayToRedirect": None,
            "isBeforeOrIdle": True
        }
        
        urlAPI = f"https://bocajuniors.queue-it.net/spa-api/queue/bocajuniors/{filaID}/{ticketId}/status"
        
        headers = {
            "Accept": "application/json, text/javascript, */*; q=0.01",
            "Accept-Language": "es-AR,es;q=0.9,en-US;q=0.8,en;q=0.7",
            "Content-Type": "application/json;charset=UTF-8",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Referer": f"https://bocajuniors.queue-it.net/?c=bocajuniors&e={filaID}&q={ticketId}",
            "Cookie": cookie_string
        }
        
        response = requests.post(urlAPI, json=payload, headers=headers, timeout=10)
        
        if response.status_code != 200:
            print(f"❌ Error HTTP {response.status_code} para ticket {ticketId}")
            return {
                "ticketId": ticketId,
                "status": "error",
                "error": f"HTTP {response.status_code}",
                "lastUpdate": time.time() * 1000
            }
        
        data = response.json()
        
        isRedirected = data.get('isRedirectToTarget', False) and data.get('redirectUrl')
        lastUpdate = time.time() * 1000
        ticket = data.get("ticket")
        url_completa = f"{fila}{filaID}&q={ticketId}"
        
        ticket = data.get("ticket")

        payloadTabla = {
            **ticket,
            "cookies": cookies,
            "isRedirected": isRedirected,
        }
        
        if isRedirected:
            print(f"🎉 Ticket {ticketId} fue redirigido!")
            payloadTabla["redirectUrl"] = data.get('redirectUrl')
        else:
            posicion = ticket.get('whichIsInLine', 'N/A') if ticket else 'N/A'
            print(f"⏳ Ticket {ticketId} sigue en espera. Posición: {posicion}")
        
        return payloadTabla
        
    except requests.exceptions.RequestException as e:
        print(f"❌ Error de conexión para ticket {ticketId}: {str(e)}")
        return {
            "ticketId": ticketId,
            "status": "error",
            "error": f"Error de conexión: {str(e)}",
            "lastUpdate": time.time() * 1000
        }
    except Exception as e:
        print(f"❌ Error al verificar ticket {ticketId}: {str(e)}")
        return {
            "ticketId": ticketId,
            "status": "error",
            "error": str(e),
            "lastUpdate": time.time() * 1000
        }


sio = socketio.Client()

@sio.event
def connect():
    print("✅ Conectado al servidor {}".format(IP))
    sio.emit("generate_login_zombie")


@sio.event
def sync_filas(filas):

    print(f"🔄 Verificando {len(filas)} filas asignadas...")
    
    if not filas:
        print("📭 No hay filas para verificar")
        return
    
    with ThreadPoolExecutor(max_workers=multitasking) as executor:
        resultados = list(executor.map(procesar, filas))
    
    print("✅ Verificación completada, enviando resultados al servidor...")
    
    for resultado in resultados:
        try:
            if resultado["status"] == "verified":
                serverRequest = requests.put(f"{IP}/filas/{resultado['ticketId']}", json=resultado)
                if serverRequest.status_code in [200, 201]:
                    print(f"✅ Fila {resultado['ticketId']} actualizada en servidor")
                else:
                    print(f"❌ Error al actualizar fila {resultado['ticketId']}: {serverRequest.status_code}")
            else:
                print(f"⚠️ Fila {resultado['ticketId']} no se pudo verificar: {resultado.get('error', 'Error desconocido')}")
        except Exception as e:
            print(f"❌ Error al comunicarse con el servidor para {resultado['ticketId']}: {str(e)}")

    sio.emit("filas_sincronizadas", resultados)
    

@sio.event
def disconnect():
    print("🔌 Cliente desconectado del servidor")

def salir(sig, frame):
    sio.disconnect()
    sys.exit(0)

signal.signal(signal.SIGINT, salir)

sio.connect(IP, transports=['websocket'])
sio.wait()
