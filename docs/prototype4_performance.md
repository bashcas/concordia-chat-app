# Prototipo 4 — Calidad: Desempeño y Escalabilidad (Performance & Scalability)

Dos escenarios. El escenario 1 aplica el **Load Balancer Pattern**; el escenario 2 aplica un
patrón definido por el equipo, el **Backplane de Publicación-Suscripción** para escalar
horizontalmente el Gateway con WebSockets.

> Las cifras del escenario 1 corresponden a la prueba de carga (k6) y deben **ajustarse a las
> mediciones reales** de tu corrida.

---

## Escenario 1 — Patrón de Balanceador de Carga (Load Balancer)

Cuando la cantidad de usuarios concurrentes supera la capacidad de una sola instancia de los
microservicios críticos (Gateway, Auth), el sistema distribuye las peticiones entrantes entre
múltiples instancias mediante un balanceador de carga, de forma que ninguna instancia individual
se convierta en cuello de botella y el throughput escale horizontalmente.

- **Fuente:** Múltiples usuarios legítimos realizando peticiones simultáneas al sistema (p. ej.
  pico de tráfico por inicio de sesión masivo o envío concurrente de mensajes).
- **Estímulo:** La carga de peticiones para el servicio de autenticación supera el umbral de
  ~100 VUs concurrentes (punto de quiebre identificado en el prototipo anterior), generando tiempos
  de respuesta superiores a 2 s y tasas de error crecientes sobre una única instancia del Gateway y
  del Auth Service.
- **Ambiente:** El sistema opera bajo carga alta sobre el clúster EKS. El tráfico entra por el NLB
  → `reverse-proxy` → `gateway` → `auth`. Cada microservicio crítico se despliega como un
  `Deployment` con múltiples réplicas.
- **Respuesta:** Se despliegan **múltiples réplicas** del Auth Service (**3**) y del Gateway
  (**2**). El balanceo de carga lo realiza el **`Service` de Kubernetes** (kube-proxy), que expone
  una IP virtual estable y distribuye las peticiones entre las réplicas sanas del pool (en el
  prototipo anterior este rol lo cumplía Nginx con el algoritmo `least_conn`). Cada réplica es
  **stateless** (el estado de sesión vive en Redis compartido y la autenticación se valida con JWT
  sin estado en servidor). Los *readiness probes* retiran automáticamente del pool a las instancias
  no saludables.
- **Medición de respuesta:** Con 3 instancias del Auth Service detrás del balanceador, el sistema
  soporta hasta **~300 VUs concurrentes con 0% de errores** y tiempos de respuesta promedio
  **< 800 ms**. El throughput escala de **~30 req/s** (1 instancia) a **~85 req/s** (3 instancias).
  La latencia **P95 se mantiene por debajo de 1.500 ms** hasta los 300 VUs. *(Ajustar a las
  mediciones reales.)*

**Tácticas:** mantener múltiples copias del servicio (réplicas); balanceo de carga (distribución de
peticiones entre instancias); mantener los servicios *stateless* (estado en Redis/JWT) para
permitir el escalado horizontal. · **Patrón:** Load Balancer Pattern.

**Cómo corroborar:**
```bash
# Prueba de carga con barrido de VUs contra el endpoint público (auth/login):
BASE_URL=https://<nlb>.elb.us-east-1.amazonaws.com/api \
  VU_LEVELS="1 50 100 200 300" ./tests/perf/run_login_test_remote.sh | tee results_3pods.txt
# Comparar contra 1 réplica:
AWS_PROFILE=concordia-kubectl kubectl scale deploy/auth -n concordia --replicas=1
BASE_URL=... VU_LEVELS="1 50 100 200 300" ./tests/perf/run_login_test_remote.sh | tee results_1pod.txt
AWS_PROFILE=concordia-kubectl kubectl scale deploy/auth -n concordia --replicas=3
# Métricas clave por nivel de VUs: http_reqs (req/s), http_req_duration p95, http_req_failed.
```

---

## Escenario 2 — Patrón de Caché (Cache-Aside con TTL) (definido por el equipo)

Cuando muchos usuarios abren canales y solicitan el historial de mensajes repetidamente, el
sistema sirve esas lecturas desde una caché en memoria (Redis) en lugar de consultar la base de
datos cada vez, reduciendo la carga sobre Cassandra y mejorando la escalabilidad de la capa de datos.

- **Fuente:** Múltiples usuarios solicitando el historial de un canal
  (`GET /channels/{id}/messages`) de forma concurrente y repetida.
- **Estímulo:** Un volumen alto de lecturas del historial sobre los mismos canales hace que cada
  petición consulte **Cassandra**, concentrando la carga de lectura sobre una BD de un solo nodo (RF=1).
- **Ambiente:** Operación bajo carga de lectura. El **Chat Service** resuelve el historial leyendo
  de Cassandra en cada petición, tras verificar permisos por gRPC contra el servicio `servers`.
- **Respuesta:** El Chat Service aplica **Cache-Aside**: **tras el chequeo de permisos** (no hay
  bypass de autorización), consulta una **caché Redis dedicada** con clave **por canal + paginación**
  (`msg:{channel}:{limit}:{before}`). En un **HIT** devuelve el resultado cacheado sin tocar
  Cassandra; en un **MISS** consulta Cassandra y guarda la respuesta con un **TTL corto (5 s)**. La
  caché es **fail-open** (si Redis no responde, se lee de Cassandra) y se habilita/deshabilita por
  env (`CHAT_CACHE_ENABLED`). Vive en una **instancia de ElastiCache dedicada**, aislada del Redis
  operativo (sesiones / rate-limit / backplane).
- **Medición de respuesta:** Con la caché habilitada, bajo carga la **tasa de aciertos es ~99.9%**
  (solo el primer MISS por canal dentro de cada ventana de TTL llega a la BD), de modo que **Cassandra
  recibe < 0.2% de las lecturas del historial** — el data tier queda **descargado**. Medido **dentro
  del clúster** (k6 → `gateway:8080`, sin el enlace de Internet de por medio), la caché además
  **reduce la latencia p95 ~40–50%**:

  | VUs concurrentes | p95 sin caché | p95 con caché | `cache_hit_rate` |
  |---:|---:|---:|---:|
  | 10  | 10.6 ms | **6.2 ms**  | 97.0% |
  | 50  | 16.7 ms | **8.5 ms**  | 99.9% |
  | 100 | 34.7 ms | **21.4 ms** | 99.85% |

  Sin caché cada lectura cruza CheckPerm (gRPC) + query a Cassandra; con caché el HIT se resuelve con
  un `GET` a Redis en memoria. Esto protege el data tier de un solo nodo (RF=1) y permite escalar el
  número de lectores sin saturar Cassandra.

  > *Nota de medición:* la prueba de carga **externa** (k6 desde una máquina remota → NLB en
  > us-east-1) quedaba **acotada por la red**, no por el servidor: con payload chico el límite es el
  > **RTT** (~115 ms, techo ~60 req/s en el ingreso — el mismo techo se ve en `/api/health`, que ni
  > toca la BD) y con payload grande el límite es el **ancho de banda** del enlace (~340 kB/s), así
  > que la latencia end-to-end no cambiaba entre caché ON/OFF. Por eso la medición de la tabla se
  > tomó **dentro del clúster** (un `Job` de k6 contra el Service `gateway:8080`), donde el servidor
  > —y no Internet— es el cuello de botella y el efecto de la caché es observable.

**Tácticas:** *caching* (mantener en memoria copias de datos de lectura frecuente); reducir/eliminar
el acceso a la base de datos en las lecturas repetidas (descargar la BD). · **Patrón:** Cache-Aside
(Lazy Loading) con invalidación por **TTL**.

**Cómo corroborar:**
```bash
NLB=https://a293b3217eada44bc8e4a58885577dea-be5f3b9a4b974f65.elb.us-east-1.amazonaws.com/api
K="AWS_PROFILE=concordia-kubectl kubectl -n concordia"
eval $K set env deploy/gateway RATE_LIMIT_ENABLED=false        # solo para medir
# (A) sin caché:
eval $K set env deploy/chat CHAT_CACHE_ENABLED=false; eval $K rollout status deploy/chat
BASE_URL=$NLB VU_LEVELS="1 50 100 200 300" ./tests/perf/run_messages_cache_test.sh | tee results_nocache.txt
# (B) con caché:
eval $K set env deploy/chat CHAT_CACHE_ENABLED=true;  eval $K rollout status deploy/chat
BASE_URL=$NLB VU_LEVELS="1 50 100 200 300" ./tests/perf/run_messages_cache_test.sh | tee results_cache.txt
eval $K set env deploy/gateway RATE_LIMIT_ENABLED=true         # restaurar seguridad
# Métrica clave: cache_hit_rate (~0% sin caché vs ~99.6% con caché) = descarga de Cassandra.
```

---

> **Nota:** El **backplane de publicación-suscripción** (Redis) sigue presente en el sistema como el
> mecanismo que permite **escalar el Gateway horizontalmente** sin perder la entrega en tiempo real
> por WebSocket (cada réplica publica/subscribe en `gateway:push`; los `connID` son globalmente
> únicos). Se considera parte del escalado horizontal del Gateway (Escenario 1 / Load Balancer), no
> un escenario de desempeño aparte.
