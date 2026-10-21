{{/*
Base name for the release.
*/}}
{{- define "cloudwatch-insights.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Fully qualified app name.
*/}}
{{- define "cloudwatch-insights.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{- define "cloudwatch-insights.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels.
*/}}
{{- define "cloudwatch-insights.labels" -}}
helm.sh/chart: {{ include "cloudwatch-insights.chart" . }}
{{ include "cloudwatch-insights.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "cloudwatch-insights.selectorLabels" -}}
app.kubernetes.io/name: {{ include "cloudwatch-insights.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "cloudwatch-insights.backend.fullname" -}}
{{ include "cloudwatch-insights.fullname" . }}-backend
{{- end }}

{{- define "cloudwatch-insights.frontend.fullname" -}}
{{ include "cloudwatch-insights.fullname" . }}-frontend
{{- end }}

{{- define "cloudwatch-insights.agent.fullname" -}}
{{ include "cloudwatch-insights.fullname" . }}-agent
{{- end }}

{{- define "cloudwatch-insights.agent.selectorLabels" -}}
{{ include "cloudwatch-insights.selectorLabels" . }}
app.kubernetes.io/component: agent
{{- end }}

{{- define "cloudwatch-insights.builder.fullname" -}}
{{ include "cloudwatch-insights.fullname" . }}-builder
{{- end }}

{{- define "cloudwatch-insights.builder.selectorLabels" -}}
{{ include "cloudwatch-insights.selectorLabels" . }}
app.kubernetes.io/component: builder
{{- end }}

{{/* The agent container's environment: the agent's Deployment and the
Builder's own (agent.builder.deployment) are the same image, configured alike. */}}
{{- define "cloudwatch-insights.agent.env" -}}
- name: PLATFORM_MCP_URL
  value: "http://{{ include "cloudwatch-insights.backend.fullname" . }}:{{ .Values.backend.service.port }}/mcp"
- name: LITELLM_BASE_URL
  value: {{ .Values.backend.ai.baseUrl | quote }}
- name: AGENT_MODEL
  value: {{ default .Values.backend.ai.model .Values.agent.model | quote }}
- name: LITELLM_API_KEY
  {{- if .Values.backend.ai.existingSecret }}
  valueFrom:
    secretKeyRef:
      name: {{ .Values.backend.ai.existingSecret }}
      key: {{ .Values.backend.ai.existingSecretKey }}
  {{- else }}
  value: {{ .Values.backend.ai.apiKey | quote }}
  {{- end }}
- name: AGENT_MAX_STEPS
  value: {{ .Values.agent.maxSteps | quote }}
{{- if ne (toString .Values.agent.temperature) "" }}
- name: AGENT_TEMPERATURE
  value: {{ .Values.agent.temperature | quote }}
{{- end }}
{{- if .Values.agent.maxTokens }}
- name: AGENT_MAX_TOKENS
  value: {{ .Values.agent.maxTokens | quote }}
{{- end }}
- name: AGENT_CHECK
  value: {{ ternary "on" "off" .Values.agent.check.enabled | quote }}
- name: AGENT_BUILDER
  value: {{ .Values.agent.builder.mode | quote }}
{{- if .Values.agent.builder.model }}
- name: AGENT_BUILDER_MODEL
  value: {{ .Values.agent.builder.model | quote }}
{{- end }}
{{- if ne (toString .Values.agent.builder.temperature) "" }}
- name: AGENT_BUILDER_TEMPERATURE
  value: {{ .Values.agent.builder.temperature | quote }}
{{- end }}
{{- if .Values.agent.builder.maxTokens }}
- name: AGENT_BUILDER_MAX_TOKENS
  value: {{ .Values.agent.builder.maxTokens | quote }}
{{- end }}
- name: AGENT_BUILDER_ROUNDS
  value: {{ .Values.agent.builder.rounds | quote }}
{{- if .Values.agent.check.model }}
- name: AGENT_CHECK_MODEL
  value: {{ .Values.agent.check.model | quote }}
{{- end }}
{{- if .Values.agent.serviceKey.existingSecret }}
- name: AGENT_SERVICE_KEY
  valueFrom:
    secretKeyRef:
      name: {{ .Values.agent.serviceKey.existingSecret }}
      key: {{ .Values.agent.serviceKey.existingSecretKey }}
{{- end }}
{{- with .Values.agent.extraEnv }}
{{- toYaml . | nindent 0 }}
{{- end }}
{{- end }}

{{- define "cloudwatch-insights.backend.selectorLabels" -}}
{{ include "cloudwatch-insights.selectorLabels" . }}
app.kubernetes.io/component: backend
{{- end }}

{{- define "cloudwatch-insights.frontend.selectorLabels" -}}
{{ include "cloudwatch-insights.selectorLabels" . }}
app.kubernetes.io/component: frontend
{{- end }}

{{/*
Name of the ServiceAccount used by the backend pod (IRSA binds to this).
*/}}
{{- define "cloudwatch-insights.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "cloudwatch-insights.backend.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{- define "cloudwatch-insights.runner.fullname" -}}
{{ include "cloudwatch-insights.fullname" . }}-runner
{{- end }}

{{- define "cloudwatch-insights.runner.selectorLabels" -}}
{{ include "cloudwatch-insights.selectorLabels" . }}
app.kubernetes.io/component: runner
{{- end }}
