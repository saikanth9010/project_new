# VM 145 Jenkins inbound agent setup

Jenkins node `northstar-docker` is already created for one executor, label `northstar-docker`, remote directory `/home/docker/jenkins-agent`, and inbound WebSocket. It is intentionally offline until the `docker` Linux account on VM 145 starts the agent. No SSH key is required on VM 145 for this inbound connection.

## Install the agent on VM 145

Use the Proxmox VM console and sign in as `docker`. The account needs sudo privileges to install packages and create a system service. Use the configured HTTPS reverse-proxy URL, `https://jenkins.saikanth.com/`; the controller's private origin is `10.10.10.10:8080` and should not be exposed directly to the internet.

Install Java and tools from Ubuntu's signed repositories, then confirm the existing Docker daemon is available to this account:

```sh
sudo apt-get update
sudo apt-get install -y openjdk-21-jre-headless git curl ca-certificates
java -version
git --version
docker version
docker compose version
```

Jenkins 2.555.1 and newer require Java 21 or 25 for agents. The pipeline runs its Node.js 24 validation inside the official `node:24-bookworm-slim` container, so no host Node.js installation is needed.

Create the agent directory and download the matching agent client from the Jenkins controller:

```sh
sudo install -d -o docker -g docker -m 0750 /home/docker/jenkins-agent
sudo curl --fail --silent --show-error --location \
  https://jenkins.saikanth.com/jnlpJars/agent.jar \
  --output /home/docker/jenkins-agent/agent.jar
sudo chown docker:docker /home/docker/jenkins-agent/agent.jar
sudo chmod 0644 /home/docker/jenkins-agent/agent.jar
```

On the Jenkins `northstar-docker` node page, copy the one-time agent secret. Create the root-only service environment file without putting the secret in a shell command or chat:

```sh
sudo install -o root -g root -m 0600 /dev/null /etc/northstar-jenkins-agent
sudoedit /etc/northstar-jenkins-agent
```

Enter exactly one line in the editor, replacing the placeholder with the secret shown by Jenkins:

```text
JENKINS_AGENT_SECRET=PASTE_THE_NODE_SECRET_HERE
```

Save and close the editor. Do not share or commit this file. Install the service unit:

```sh
sudo tee /etc/systemd/system/northstar-docker-agent.service >/dev/null <<'UNIT'
[Unit]
Description=Northstar Jenkins inbound Docker agent
Wants=network-online.target
After=network-online.target docker.service
Requires=docker.service

[Service]
Type=simple
User=docker
SupplementaryGroups=docker
WorkingDirectory=/home/docker/jenkins-agent
EnvironmentFile=/etc/northstar-jenkins-agent
ExecStart=/usr/bin/java -jar /home/docker/jenkins-agent/agent.jar -url https://jenkins.saikanth.com/ -secret ${JENKINS_AGENT_SECRET} -name northstar-docker -webSocket -workDir /home/docker/jenkins-agent
Restart=always
RestartSec=10
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectProc=invisible
RestrictSUIDSGID=true
LockPersonality=true

[Install]
WantedBy=multi-user.target
UNIT
sudo chmod 0644 /etc/systemd/system/northstar-docker-agent.service
sudo systemctl daemon-reload
sudo systemctl enable --now northstar-docker-agent
sudo systemctl status northstar-docker-agent --no-pager
```

Jenkins should show the node online. Check service logs locally with `sudo journalctl -u northstar-docker-agent -n 100 --no-pager`; redact secrets before sharing logs. The VM initiates a WebSocket connection to port 8080, so this does not require opening the inbound agent port 50000.

## Scope and trust

The agent account can use the Docker socket. Docker access is effectively root access to VM 145, so run only trusted builds on it. The Jenkins multibranch job must discover only the protected `main` branch and must not build forks or pull requests. Keep Jenkins administrators and GitHub write access tightly controlled. Do not expose Jenkins port 8080 to the public internet.

The agent uses the configured HTTPS reverse proxy and validates its certificate using Ubuntu's system trust store. The proxy must preserve the `Host` header, set `X-Forwarded-Proto: https`, and pass WebSocket upgrade requests. Jenkins currently shows a reverse-proxy warning when configured through the LAN origin; check the proxy's forwarded headers and confirm the URL below responds from VM 145 before starting the agent:

```sh
curl --fail --show-error --head https://jenkins.saikanth.com/login
curl --fail --show-error --head https://jenkins.saikanth.com/jnlpJars/agent.jar
```

If certificate validation or routing fails, fix the existing proxy configuration before starting the service. Do not disable TLS verification or switch the agent to plain HTTP.
