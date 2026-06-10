# Prototipo 4 — Calidad: Confiabilidad (Reliability)

Concordia se rediseñó para desplegarse sobre **AWS EKS** (Kubernetes gestionado); ver
`docs/aws-deploy-summary.md`. Sobre esa base se satisfacen **cuatro escenarios de confiabilidad**.
La plataforma de Kubernetes/AWS ya realiza los patrones de Replicación, Service Discovery y
Clúster; el patrón definido por el equipo (Circuit Breaker) y los *liveness probes* se añadieron
explícitamente.

| # | Patrón | Realizado por | Táctica principal |
|---|---|---|---|
| 1 | Replicación (Hot Spare) | Deployments + réplicas (`auth=3`, `gateway=2`) + ReplicaSet | Redundancia activa |
| 2 | Service Discovery | Kubernetes `Service` + CoreDNS + controlador de Endpoints | Registro de servicios |
| 3 | Clúster | Node group de EKS (3 nodos) + clúster Kafka MSK (2 brokers) | Clustering + failover |
| 4 | Circuit Breaker (equipo) | Breaker por-upstream en el Gateway | Limitar exposición / aislar fallos |

> Nota sobre métricas: solo el escenario de **desempeño** (Load Balancer) reporta cifras de
> throughput/latencia. En confiabilidad las mediciones son de **disponibilidad y recuperación**
> (0 errores durante el fallo, fast-fail, recuperación automática), observables en las pruebas.

Datos de las pruebas — URL pública (NLB):
`https://a293b3217eada44bc8e4a58885577dea-be5f3b9a4b974f65.elb.us-east-1.amazonaws.com`
Acceso a `kubectl`: prefijo `AWS_PROFILE=concordia-kubectl` (namespace `concordia`).

---

## Escenario 1 — Patrón de Replicación (Hot Spare)

Cuando una instancia (pod) de un microservicio crítico falla abruptamente, el sistema mantiene la
disponibilidad del servicio gracias a réplicas activas redundantes y restaura automáticamente la
instancia caída, de forma que la pérdida de una instancia no interrumpe el servicio.

- **Fuente:** Fallo de una instancia de un microservicio crítico (caída del proceso, OOM,
  excepción no recuperable o terminación del contenedor).
- **Estímulo:** Una de las instancias activas del servicio (p. ej. el Auth Service) deja de
  responder de manera abrupta mientras el sistema atiende tráfico de usuarios.
- **Ambiente:** Operación normal. El servicio `auth` se ejecuta con **3 réplicas activas** (hot
  spares) y el `gateway` con **2**, detrás de un `Service` de Kubernetes. Todas las réplicas
  atienden tráfico simultáneamente (activo-activo); no hay una réplica "ociosa".
- **Respuesta:** El `Service` deja de enrutar peticiones a la réplica caída (detectada porque su
  *readiness probe* falla) y redistribuye el tráfico entre las réplicas sanas. El controlador
  **ReplicaSet** detecta que el número de réplicas deseadas no se cumple y crea automáticamente una
  nueva instancia para restaurar la redundancia. El *liveness probe* reinicia automáticamente
  cualquier pod que quede colgado.
- **Medición de respuesta:** La caída de una réplica **no produce errores visibles para el
  usuario** (0% de peticiones con error 5xx o conexión rechazada mientras quede ≥1 réplica sana).
  El ReplicaSet recrea la instancia automáticamente (reprogramación en pocos segundos + arranque
  del servicio), sin intervención manual.

**Tácticas:** redundancia activa (hot spare); detección de fallos (health probes); recuperación /
reintroducción (reschedule + ReplicaSet). · **Patrón:** Replication Pattern (Hot Spare).

**Cómo corroborar:**
```bash
NLB=https://a293b3217eada44bc8e4a58885577dea-be5f3b9a4b974f65.elb.us-east-1.amazonaws.com
# (1) Terminal A — bucle de peticiones; lo relevante es que NUNCA aparezcan 5xx/conexión rechazada:
while true; do curl -k -s -o /dev/null -w "%{http_code} " -X POST $NLB/api/auth/login \
  -H 'content-type: application/json' -d '{"email":"x@x.com","password":"x"}'; sleep 0.3; done
#   (403 = credenciales inválidas = el servicio respondió; un 502/503 sería el fallo a evitar)
# (2) Terminal B — matar una réplica de auth y observar la recreación automática:
AWS_PROFILE=concordia-kubectl kubectl delete pod -n concordia \
  "$(AWS_PROFILE=concordia-kubectl kubectl get pod -n concordia -l app=auth -o name | head -1)"
AWS_PROFILE=concordia-kubectl kubectl get pods -n concordia -l app=auth -w
#   Verás: 1 pod Terminating + uno nuevo ContainerCreating -> Running (lo recreó el ReplicaSet),
#   mientras el bucle de la Terminal A sigue respondiendo sin 5xx.
```

---

## Escenario 2 — Patrón de Service Discovery

Cuando las instancias de los servicios cambian de ubicación (IP) dinámicamente —por
reprogramación, escalado o recreación tras un fallo—, los demás servicios las siguen encontrando
automáticamente, sin reconfiguración ni reinicios, porque se comunican por nombre lógico y no por
dirección IP.

- **Fuente:** Cambios dinámicos en la ubicación de las instancias (las IP de los pods son
  efímeras y cambian con cada reprogramación, escalado o recreación).
- **Estímulo:** Un pod de un servicio se recrea con una **IP nueva** (por un fallo, un despliegue o
  un reescalado) mientras otros servicios necesitan comunicarse con él.
- **Ambiente:** Operación normal. Los microservicios se comunican entre sí por **nombre lógico**
  (`auth:8081`, `servers:50051`, `presence:8086`, …), nunca por IP fija.
- **Respuesta:** Kubernetes funciona como **registro de servicios**: cada `Service` expone una IP
  virtual estable (ClusterIP) y un nombre DNS resuelto por **CoreDNS**. El controlador de
  **Endpoints** registra y desregistra automáticamente las IP de los pods *sanos* (según readiness)
  de cada `Service`. Cuando un pod se recrea con nueva IP, los Endpoints se actualizan y CoreDNS
  sigue resolviendo el mismo nombre; los consumidores no requieren reconfiguración ni reinicio.
- **Medición de respuesta:** Descubrimiento **automático y transparente**: tras recrear un pod, su
  nueva IP aparece registrada en los Endpoints del `Service` en segundos, sin intervención manual
  ni cambios de configuración en los consumidores. El 100% de las llamadas inter-servicio se
  resuelven por nombre (cero acoplamiento a IP).

**Tácticas:** registro de servicios; enlace dinámico/tardío (late binding); membresía basada en
salud. · **Patrón:** Service Discovery (server-side: Kubernetes Services + CoreDNS).

**Cómo corroborar:**
```bash
K="AWS_PROFILE=concordia-kubectl kubectl -n concordia"
# (1) Ver el "registro": las IP de los pods detrás del Service auth:
eval $K get endpoints auth -o wide          # anota las IPs
# (2) Recrear un pod (cambia su IP):
eval $K delete pod "$(eval $K get pod -l app=auth -o name | head -1)"
# (3) Volver a consultar: la IP del pod recreado cambió y el Service la registró sola:
eval $K get endpoints auth -o wide
# (4) Resolución por nombre desde otro servicio (el gateway sigue llamando a http://auth:8081):
eval $K exec deploy/gateway -- sh -c "getent hosts auth || nslookup auth"
```

---

## Escenario 3 — Patrón de Clúster (Cluster)

Cuando un **nodo de cómputo completo** falla (no solo un pod), el sistema reubica automáticamente
las cargas afectadas en los nodos sanos restantes del clúster, manteniendo el servicio disponible
mientras quede capacidad.

- **Fuente:** Fallo de un nodo worker completo (caída de la instancia EC2, agotamiento de recursos
  del nodo, o mantenimiento/drenaje).
- **Estímulo:** Uno de los nodos del clúster EKS se vuelve inalcanzable (NotReady) o es drenado,
  llevándose consigo todos los pods que alojaba.
- **Ambiente:** Operación normal. El sistema corre sobre un **clúster EKS** con un *managed node
  group* de **3 nodos** (mínimo 2, máximo 4) en 2 zonas de disponibilidad. Adicionalmente, los
  eventos fluyen por un **clúster Kafka gestionado (MSK)** de **2 brokers** con factor de
  replicación 2.
- **Respuesta:** El plano de control de Kubernetes detecta el nodo no disponible y **reprograma**
  los pods afectados hacia los nodos sanos; el Deployment/ReplicaSet restablece el número de
  réplicas deseadas y el `Service` redirige el tráfico a las nuevas ubicaciones (vía Endpoints). En
  el clúster Kafka, con RF=2 los topics siguen disponibles aun si cae un broker.
- **Medición de respuesta:** El sistema **tolera la pérdida de un nodo completo sin interrupción**:
  los pods se reprograman a otros nodos y vuelven a `Running`; las peticiones continúan
  atendiéndose (degradación temporal mínima durante el reschedule). La capacidad se mantiene
  mientras queden nodos sanos (≥2); Kafka conserva los mensajes (RF=2) ante la caída de 1 broker.

**Tácticas:** clustering; detección de fallos de nodo; reprogramación/failover; redundancia de
datos (RF=2 en Kafka). · **Patrón:** Cluster Pattern (clúster de nodos EKS + clúster de brokers MSK).

**Cómo corroborar:**
```bash
K="AWS_PROFILE=concordia-kubectl kubectl -n concordia"
# (1) Ver en qué nodos corren los pods:
eval $K get pods -o wide
AWS_PROFILE=concordia-kubectl kubectl get nodes
# (2) Simular el fallo/mantenimiento de un nodo (drenarlo):
AWS_PROFILE=concordia-kubectl kubectl drain <node-name> --ignore-daemonsets --delete-emptydir-data
# (3) Observar la reprogramación de los pods de ese nodo hacia otros nodos:
eval $K get pods -o wide -w
#   (en paralelo, un curl a la app sigue respondiendo)
# (4) Reintegrar el nodo al clúster:
AWS_PROFILE=concordia-kubectl kubectl uncordon <node-name>
```

---

## Escenario 4 — Patrón Circuit Breaker (definido por el equipo)

Cuando un microservicio aguas abajo deja de responder o responde con errores de forma sostenida,
el Gateway "abre el circuito" hacia ese servicio y falla de inmediato (fast-fail) en lugar de
quedarse esperando, aislando el fallo a ese único servicio y evitando un fallo en cascada que
agote los recursos del Gateway.

- **Fuente:** Un microservicio aguas abajo (p. ej. el Auth Service) se vuelve no disponible o muy
  lento (caído, saturado, o con la red particionada).
- **Estímulo:** Las peticiones del Gateway hacia ese *upstream* comienzan a **fallar
  repetidamente** (errores de conexión o respuestas 5xx) o a colgarse hasta el timeout.
- **Ambiente:** Operación bajo fallo parcial. El Gateway hace de proxy hacia varios servicios. Sin
  protección, cada petición a un upstream caído esperaría hasta el timeout, acumulando
  conexiones/goroutines y arriesgando el agotamiento de recursos del Gateway (fallo en cascada que
  afectaría también a los servicios sanos).
- **Respuesta:** El Gateway envuelve **cada upstream con su propio Circuit Breaker**. Tras **5
  fallos consecutivos** (5xx o error de conexión) el breaker pasa a estado **abierto** y el Gateway
  responde de inmediato con `503` sin contactar al servicio caído (fast-fail), protegiendo sus
  recursos y **aislando** el fallo a ese upstream (los demás siguen operando). Tras **~10 s** el
  breaker pasa a **half-open** y deja pasar una petición de prueba; si tiene éxito, se **cierra** y
  se restablece el tráfico normal. Como tácticas de apoyo, los *liveness probes* reinician
  automáticamente los pods colgados.
- **Medición de respuesta:** Al caer el upstream, el tiempo de respuesta del Gateway baja de
  ~timeout (segundos, colgado) a ~**milisegundos** (503 inmediato) una vez abierto el breaker. El
  fallo queda **aislado** (los demás servicios siguen respondiendo 200). La **recuperación es
  automática**: al restaurar el servicio el breaker se cierra solo, sin intervención.

**Tácticas:** limitar la exposición; detección de fallos; degradación elegante; prevención de
fallos en cascada. · **Patrón:** Circuit Breaker.

*Implementación:* breaker por-upstream en el Gateway (Go, `github.com/sony/gobreaker/v2`):
`services/gateway/breaker.go` (un `http.RoundTripper` envuelto en el breaker; falla = error de
transporte o `status >= 500`) y `services/gateway/server.go` (`mustProxy` setea ese `Transport` y
un `ErrorHandler` que responde `503` rápido). Umbrales por entorno:
`GATEWAY_CB_MAX_FAILURES` (def. 5), `GATEWAY_CB_OPEN_SECONDS` (def. 10).

**Cómo corroborar:**
```bash
NLB=https://a293b3217eada44bc8e4a58885577dea-be5f3b9a4b974f65.elb.us-east-1.amazonaws.com
K="AWS_PROFILE=concordia-kubectl kubectl -n concordia"
# (1) Provocar la caída del Auth Service (0 réplicas):
eval $K scale deploy/auth --replicas=0
# (2) Medir el tiempo de respuesta del login repetidamente:
for i in $(seq 1 12); do curl -k -s -o /dev/null \
  -w "intento $i: http=%{http_code} t=%{time_total}s\n" -X POST $NLB/api/auth/login \
  -H 'content-type: application/json' -d '{"email":"x@x.com","password":"x"}'; done
#   Las primeras tardan (intentando conectar); tras 5 fallos el breaker se ABRE -> 503 en ms.
# (3) Ver el cambio de estado en los logs del gateway:
eval $K logs -l app=gateway --tail=30 | grep -i breaker      # p.ej. circuit breaker "auth": closed -> open
# (4) AISLAMIENTO: el gateway y otros servicios siguen sanos (el breaker es por-upstream):
curl -k -s -o /dev/null -w "gateway/health: %{http_code}\n" $NLB/api/health
# (5) Restaurar auth y ver el breaker cerrarse solo:
eval $K scale deploy/auth --replicas=3
#   Tras ~10 s + arranque, repetir el login -> vuelve a 200 (logs: open -> half-open -> closed).
```

---

## Seguridad preservada (requisito del prototipo)

Los patrones de seguridad del Prototipo 3 se mantienen en el rediseño sobre EKS:
- **Único ingreso público** (Reverse Proxy): solo el `reverse-proxy` es público (Service tipo
  LoadBalancer → NLB); el resto de servicios son `ClusterIP` (no accesibles desde Internet).
- **Segmentación de red:** los pods y los almacenes de datos viven en subredes privadas; solo el
  NLB es internet-facing.
- **Canal seguro:** TLS terminado en el reverse-proxy.
- **Propagación JWT:** el Gateway valida el token y reenvía `X-User-ID` a los upstreams; estos
  confían en esa cabecera porque no son alcanzables salvo a través del Gateway.
- **Audit Trail:** el servicio `audit` consume `audit.events` de Kafka y los encadena por hash en
  una BD `audit` *append-only* con roles `audit_writer` (solo INSERT) / `audit_reader` (solo SELECT).

## Escenario de Interoperabilidad (requisito del prototipo)

Servicios poliglotas (Go, Java, Rust, Python, TypeScript) interoperan mediante **contratos
compartidos** en `contracts/`:
- **REST/JSON** a través del Gateway (contrato `contracts/openapi/gateway.yaml`).
- **gRPC**: `PermService.CheckPerm` (`contracts/proto/check_perm.proto`) — p. ej. el servicio
  `chat` (Rust) consulta permisos al servicio `servers` (Java) por gRPC antes de operar sobre un
  canal.
- **Eventos Kafka** con esquemas JSON (`contracts/kafka-schemas/`) — p. ej. `auth` (Java) emite
  `user-registered`, consumido por `audit` (Go) y `servers` (Java).

**Escenario:** un servicio escrito en un lenguaje invoca operaciones de otro escrito en un lenguaje
distinto, sin acoplarse a su implementación, usando un contrato/formato compartido (Protobuf, JSON
Schema, OpenAPI). **Tácticas:** contratos de interfaz / formatos de datos comunes; orquestación a
través del Gateway. **Patrón:** API Gateway + contratos compartidos (interface/data interoperability).
