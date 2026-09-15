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
