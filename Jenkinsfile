pipeline {
  agent { label 'northstar-docker' }

  options {
    disableConcurrentBuilds()
    timestamps()
    timeout(time: 45, unit: 'MINUTES')
  }

  environment {
    // Update these private deployment addresses before creating the Jenkins job.
    GHCR_OWNER = 'saikanth9010'
    BACKEND_HOST = 'SET_BACKEND_PRIVATE_IP'
    FRONTEND_HOST = 'SET_FRONTEND_PRIVATE_IP'
  }

  stages {
    stage('Checkout') {
      steps { checkout scm }
    }

    stage('Validate source') {
      steps {
        sh '''
          set -eu
          node --version
          npm ci
          node --check app.js
          node --check server.mjs
        '''
      }
    }

    stage('Set immutable image tags') {
      when { branch 'main' }
      steps {
        script {
          def owner = env.GHCR_OWNER.trim().toLowerCase()
          if (!(owner ==~ /^[a-z0-9][a-z0-9-]{0,38}$/)) {
            error('Set GHCR_OWNER to the lowercase GitHub user or organization that owns the container packages.')
          }
          if (env.BACKEND_HOST.startsWith('SET_') || env.FRONTEND_HOST.startsWith('SET_')) {
            error('Set BACKEND_HOST and FRONTEND_HOST to private VM addresses in the Jenkinsfile.')
          }
          if (!(env.BACKEND_HOST ==~ /^[A-Za-z0-9][A-Za-z0-9.-]*$/) || !(env.FRONTEND_HOST ==~ /^[A-Za-z0-9][A-Za-z0-9.-]*$/)) {
            error('Deployment hosts must be private IP addresses or DNS hostnames without shell characters.')
          }
          env.IMAGE_TAG = env.GIT_COMMIT.take(12)
          env.API_IMAGE = "ghcr.io/${owner}/northstar-api:${env.IMAGE_TAG}"
          env.FRONTEND_IMAGE = "ghcr.io/${owner}/northstar-frontend:${env.IMAGE_TAG}"
        }
      }
    }

    stage('Build images') {
      when { branch 'main' }
      steps {
        sh '''
          set -eu
          docker build --pull --build-arg VCS_REF="$GIT_COMMIT" \
            -f deploy/docker/Dockerfile.api -t "$API_IMAGE" .
          docker build --pull --build-arg VCS_REF="$GIT_COMMIT" \
            -f deploy/docker/Dockerfile.frontend -t "$FRONTEND_IMAGE" .
        '''
      }
    }

    stage('Publish images to GHCR') {
      when { branch 'main' }
      steps {
        withCredentials([usernamePassword(credentialsId: 'northstar-ghcr-writer', usernameVariable: 'GHCR_USER', passwordVariable: 'GHCR_TOKEN')]) {
          sh '''
            set -eu
            set +x
            trap 'docker logout ghcr.io >/dev/null 2>&1 || true' EXIT
            printf '%s' "$GHCR_TOKEN" | docker login ghcr.io --username "$GHCR_USER" --password-stdin
            docker push "$API_IMAGE"
            docker push "$FRONTEND_IMAGE"
          '''
        }
      }
    }

    stage('Deploy backend and run migrations') {
      when { branch 'main' }
      steps {
        withEnv(["DEPLOY_HOST=${env.BACKEND_HOST}", "DEPLOY_IMAGE=${env.API_IMAGE}"]) {
          withCredentials([sshUserPrivateKey(credentialsId: 'northstar-backend-deploy', keyFileVariable: 'SSH_KEY', usernameVariable: 'SSH_USER'), usernamePassword(credentialsId: 'northstar-ghcr-writer', usernameVariable: 'GHCR_USER', passwordVariable: 'GHCR_TOKEN')]) {
            sh '''
              set -eu
              scp -i "$SSH_KEY" -o BatchMode=yes -o StrictHostKeyChecking=yes \
                deploy/docker/compose.backend.yml "$SSH_USER@$DEPLOY_HOST:/opt/northstar/compose.backend.yml"
              case "$GHCR_USER" in ''|*[!A-Za-z0-9-]*) echo 'GHCR credential username must be a GitHub username.' >&2; exit 1 ;; esac
              printf '%s' "$GHCR_TOKEN" | ssh -i "$SSH_KEY" -o BatchMode=yes -o StrictHostKeyChecking=yes \
                "$SSH_USER@$DEPLOY_HOST" "docker login ghcr.io --username $GHCR_USER --password-stdin" >/dev/null
              trap 'status=$?; trap - EXIT; ssh -i "$SSH_KEY" -o BatchMode=yes -o StrictHostKeyChecking=yes "$SSH_USER@$DEPLOY_HOST" docker logout ghcr.io >/dev/null 2>&1 || true; exit "$status"' EXIT
              ssh -i "$SSH_KEY" -o BatchMode=yes -o StrictHostKeyChecking=yes \
                "$SSH_USER@$DEPLOY_HOST" sh -s -- "$DEPLOY_IMAGE" <<'REMOTE'
              set -eu
              new_image="$1"
              cd /opt/northstar
              test -r runtime.env
              test -r backend.runtime.env
              test -r backend.migration.env
              previous_image=''
              if [ -f backend.deploy.env ]; then
                previous_image="$(sed -n 's/^API_IMAGE=//p' backend.deploy.env | head -n 1)"
              fi
              printf 'API_IMAGE=%s\\n' "$new_image" > backend.deploy.env.tmp
              chmod 600 backend.deploy.env.tmp
              mv backend.deploy.env.tmp backend.deploy.env
              dc() { docker compose --env-file runtime.env --env-file backend.deploy.env -f compose.backend.yml "$@"; }
              rollback_on_failure() {
                status=$?
                trap - EXIT
                if [ "$status" -ne 0 ] && [ -n "$previous_image" ]; then
                  current_image="$(sed -n 's/^API_IMAGE=//p' backend.deploy.env | head -n 1)"
                  if [ "$current_image" = "$new_image" ]; then
                    printf 'API_IMAGE=%s\\n' "$previous_image" > backend.deploy.env.tmp
                    chmod 600 backend.deploy.env.tmp
                    mv backend.deploy.env.tmp backend.deploy.env
                    dc pull api >/dev/null 2>&1 || true
                    dc up -d --no-deps api >/dev/null 2>&1 || true
                  fi
                fi
                exit "$status"
              }
              trap rollback_on_failure EXIT
              dc --profile ops pull api migrate
              dc --profile ops run --rm migrate
              dc up -d --no-deps api
              healthy=0
              for attempt in 1 2 3 4 5 6 7 8 9 10; do
                if dc exec -T api node -e 'fetch("http://127.0.0.1:4173/api/health").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'; then
                  healthy=1
                  break
                fi
                sleep 3
              done
              if [ "$healthy" -ne 1 ]; then
                echo 'Backend health check failed.' >&2
                if [ -n "$previous_image" ]; then
                  printf 'API_IMAGE=%s\\n' "$previous_image" > backend.deploy.env.tmp
                  chmod 600 backend.deploy.env.tmp
                  mv backend.deploy.env.tmp backend.deploy.env
                  dc pull api
                  dc up -d --no-deps api
                fi
                exit 1
              fi
REMOTE
            '''
          }
        }
      }
    }

    stage('Deploy frontend') {
      when { branch 'main' }
      steps {
        withEnv(["DEPLOY_HOST=${env.FRONTEND_HOST}", "DEPLOY_IMAGE=${env.FRONTEND_IMAGE}"]) {
          withCredentials([sshUserPrivateKey(credentialsId: 'northstar-frontend-deploy', keyFileVariable: 'SSH_KEY', usernameVariable: 'SSH_USER'), usernamePassword(credentialsId: 'northstar-ghcr-writer', usernameVariable: 'GHCR_USER', passwordVariable: 'GHCR_TOKEN')]) {
            sh '''
              set -eu
              scp -i "$SSH_KEY" -o BatchMode=yes -o StrictHostKeyChecking=yes \
                deploy/docker/compose.frontend.yml "$SSH_USER@$DEPLOY_HOST:/opt/northstar/compose.frontend.yml"
              case "$GHCR_USER" in ''|*[!A-Za-z0-9-]*) echo 'GHCR credential username must be a GitHub username.' >&2; exit 1 ;; esac
              printf '%s' "$GHCR_TOKEN" | ssh -i "$SSH_KEY" -o BatchMode=yes -o StrictHostKeyChecking=yes \
                "$SSH_USER@$DEPLOY_HOST" "docker login ghcr.io --username $GHCR_USER --password-stdin" >/dev/null
              trap 'status=$?; trap - EXIT; ssh -i "$SSH_KEY" -o BatchMode=yes -o StrictHostKeyChecking=yes "$SSH_USER@$DEPLOY_HOST" docker logout ghcr.io >/dev/null 2>&1 || true; exit "$status"' EXIT
              ssh -i "$SSH_KEY" -o BatchMode=yes -o StrictHostKeyChecking=yes \
                "$SSH_USER@$DEPLOY_HOST" sh -s -- "$DEPLOY_IMAGE" <<'REMOTE'
              set -eu
              new_image="$1"
              cd /opt/northstar
              test -r runtime.env
              previous_image=''
              if [ -f frontend.deploy.env ]; then
                previous_image="$(sed -n 's/^FRONTEND_IMAGE=//p' frontend.deploy.env | head -n 1)"
              fi
              printf 'FRONTEND_IMAGE=%s\\n' "$new_image" > frontend.deploy.env.tmp
              chmod 600 frontend.deploy.env.tmp
              mv frontend.deploy.env.tmp frontend.deploy.env
              dc() { docker compose --env-file runtime.env --env-file frontend.deploy.env -f compose.frontend.yml "$@"; }
              rollback_on_failure() {
                status=$?
                trap - EXIT
                if [ "$status" -ne 0 ] && [ -n "$previous_image" ]; then
                  current_image="$(sed -n 's/^FRONTEND_IMAGE=//p' frontend.deploy.env | head -n 1)"
                  if [ "$current_image" = "$new_image" ]; then
                    printf 'FRONTEND_IMAGE=%s\\n' "$previous_image" > frontend.deploy.env.tmp
                    chmod 600 frontend.deploy.env.tmp
                    mv frontend.deploy.env.tmp frontend.deploy.env
                    dc pull frontend >/dev/null 2>&1 || true
                    dc up -d --no-deps frontend >/dev/null 2>&1 || true
                  fi
                fi
                exit "$status"
              }
              trap rollback_on_failure EXIT
              dc pull frontend
              dc up -d --no-deps frontend
              healthy=0
              for attempt in 1 2 3 4 5 6 7 8 9 10; do
                if dc exec -T frontend curl -fsS http://127.0.0.1:8080/healthz >/dev/null; then
                  healthy=1
                  break
                fi
                sleep 3
              done
              if [ "$healthy" -ne 1 ]; then
                echo 'Frontend health check failed.' >&2
                if [ -n "$previous_image" ]; then
                  printf 'FRONTEND_IMAGE=%s\\n' "$previous_image" > frontend.deploy.env.tmp
                  chmod 600 frontend.deploy.env.tmp
                  mv frontend.deploy.env.tmp frontend.deploy.env
                  dc pull frontend
                  dc up -d --no-deps frontend
                fi
                exit 1
              fi
REMOTE
            '''
          }
        }
      }
    }
  }
}
