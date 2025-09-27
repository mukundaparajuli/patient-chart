const env = require("../config/env.js");
const https = require("https");
const { default: axios } = require("axios");
const FormData = require("form-data");

class BahmniService {
    constructor() {
        // Validate critical configuration
        if (!env.bahmni?.baseUrl) {
            throw new Error("Bahmni base URL is not configured");
        }
        if (!env.bahmni.bahmniUsername || !env.bahmni.bahmniPassword) {
            throw new Error("Bahmni authentication credentials not configured");
        }

        this.httpsAgent = new https.Agent({
            rejectUnauthorized: false,
            timeout: env.bahmni.timeout || 30000, // Increased timeout for file uploads
            keepAlive: true,
        });

        this.authConfig = {
            auth: {
                username: env.bahmni.bahmniUsername,
                password: env.bahmni.bahmniPassword,
            },
            httpsAgent: this.httpsAgent,
        };
    }

    async _makeRequest(method, url, data, headers = {}) {
        try {
            const config = {
                ...this.authConfig,
                method,
                url,
                timeout: env.bahmni.timeout || 30000,
                maxContentLength: Infinity,
                maxBodyLength: Infinity,
            };

            if (data) {
                if (data instanceof FormData) {
                    config.data = data;
                    config.headers = { ...headers };
                } else {
                    config.data = data;
                    config.headers = { 'Content-Type': 'application/json', ...headers };
                }
            } else {
                config.headers = { 'Content-Type': 'application/json', ...headers };
            }

            console.log(`Making ${method.toUpperCase()} request to: ${url}`);
            console.log("Auth config:", {
                username: this.authConfig.auth.username,
                hasPassword: !!this.authConfig.auth.password,
            });

            if (data && method.toLowerCase() !== 'get') {
                if (data instanceof FormData) {
                    console.log("Request with FormData - fields:", Object.keys(data.getHeaders()));
                    const fields = [];
                    data._streams.forEach((stream) => {
                        if (typeof stream === 'string' && stream.includes('name="')) {
                            const match = stream.match(/name="([^"]+)"/);
                            if (match) fields.push(match[1]);
                        }
                    });
                    console.log("FormData field names:", fields);
                } else {
                    console.log("Request payload:", JSON.stringify(data, null, 2));
                }
            }
            console.log("Request headers:", JSON.stringify(config.headers, null, 2));

            const response = await axios(config);
            console.log(`Request successful: ${response.status}`);
            return response.data;

        } catch (error) {
            console.error(`Request failed:`, error.message);
            console.error("Error code:", error.code);
            console.error("Response status:", error.response?.status);

            // ❌ No retries, just throw formatted error
            throw this._formatError(error);
        }
    }


    _isRetryable(error) {
        return (
            !error.response ||
            error.code === "ECONNABORTED" ||
            error.code === "ETIMEDOUT" ||
            error.code === "ECONNRESET" ||
            error.code === "ENOTFOUND" ||
            (error.response && error.response.status >= 500)
        );
    }

    _formatError(error) {
        if (error.response) {
            const status = error.response.status;
            let message = "Unknown error";

            // Handle different response data formats
            if (error.response.data) {
                if (typeof error.response.data === 'string') {
                    message = error.response.data;
                } else if (error.response.data.message) {
                    message = error.response.data.message;
                } else if (error.response.data.error) {
                    message = error.response.data.error;
                } else {
                    // If it's an object, stringify it properly
                    message = JSON.stringify(error.response.data);
                }
            }

            console.error(`HTTP ${status} Error Response:`, error.response.data);
            const err = new Error(`Request failed with status ${status}: ${message}`);
            err.statusCode = status;
            err.responseData = error.response.data;
            return err;
        } else if (error.request) {
            const err = new Error("No response received from Bahmni server");
            err.statusCode = 502;
            return err;
        } else {
            const err = new Error(`Request setup error: ${error.message}`);
            err.statusCode = 500;
            return err;
        }
    }

    async uploadDocument(documentData) {
        try {
            console.log("Uploading document to Bahmni...");
            console.log("Document data structure:", {
                hasContent: !!documentData.content,
                contentLength: documentData.content?.length,
                encounterTypeName: documentData.encounterTypeName,
                visitUuid: documentData.visitUuid,
                format: documentData.format,
                patientUuid: documentData.patientUuid,
                fileType: documentData.fileType,
                fileName: documentData.fileName
            });

            const requiredFields = ['content', 'encounterTypeName', 'visitUuid', 'format', 'patientUuid', 'fileType', 'fileName'];
            for (const field of requiredFields) {
                if (!documentData[field]) {
                    throw new Error(`Missing required field: ${field}`);
                }
            }

            const payload = {
                content: documentData.content,
                format: documentData.format,
                patientUuid: documentData.patientUuid,
                encounterTypeName: documentData.encounterTypeName,
                fileType: documentData.fileType,
            };

            const response = await this._makeRequest(
                "post",
                `${env.bahmni.baseUrl}/ws/rest/v1/bahmnicore/visitDocument/uploadDocument`,
                payload
            );

            if (!response?.url) {
                throw new Error("Invalid response from Bahmni - missing document URL");
            }

            return response;

        } catch (error) {
            throw new Error(`Failed to upload document: ${error.message}`);
        }
    }

    async linkDocumentToPatient(data) {
        try {
            const response = await this._makeRequest(
                "post",
                `${env.bahmni.baseUrl}/ws/rest/v1/bahmnicore/visitDocument`,
                data
            );
            return response;
        } catch (error) {
            throw new Error(`Failed to link document: ${error.message}`);
        }
    }

    async getPatientUuid(patientMRN) {
        try {
            console.log(`Looking up patient with MRN: ${patientMRN}`);

            const url = `${env.bahmni.baseUrl}/ws/rest/v1/patient?q=${encodeURIComponent(patientMRN)}&v=full`;
            const patientInfo = await this._makeRequest("get", url);

            if (!patientInfo.results?.length) {
                throw new Error(`Patient with MRN ${patientMRN} not found`);
            }

            const patientUuid = patientInfo.results[0].person.uuid;
            console.log(`Patient found - UUID: ${patientUuid}`);
            return patientUuid;

        } catch (error) {
            console.error("Patient lookup failed:", error);
            throw new Error(`Failed to find patient: ${error.message}`);
        }
    }

    async getVisitUuid(patientUuid) {
        try {
            console.log(`Looking up visits for patient: ${patientUuid}`);

            const url = `${env.bahmni.baseUrl}/ws/rest/v1/visit?patient=${patientUuid}&v=full`;
            const response = await this._makeRequest("get", url);

            if (!response.results?.length) {
                throw new Error(`No visits found for patient ${patientUuid}`);
            }

            // Get the most recent active visit or create a new one
            const activeVisit = response.results.find(visit => !visit.stopDatetime) || response.results[0];
            console.log(`Visit found - UUID: ${activeVisit.uuid}`);
            return activeVisit.uuid;

        } catch (error) {
            console.error("Visit lookup failed:", error);
            throw new Error(`Failed to get visit UUID: ${error.message}`);
        }
    }

    async getVisitStartDateAndEndDate(visitUuid) {
        try {
            const visitInfo = await this._makeRequest('get', `${env.bahmni.baseUrl}/ws/rest/v1/visit/${visitUuid}`);
            console.log(visitInfo);
            const startDatetime = visitInfo.startDatetime;
            const stopDatetime = visitInfo.stopDatetime;
            return { startDatetime, stopDatetime };
        } catch (error) {
            console.log(error)
        }
    }

    async getProviderUuid(patientUuid, encounterType) {
        try {
            console.log("Getting provider UUID from session...");

            const url = `${env.bahmni.baseUrl}/ws/rest/v1/provider`;

            const response = await this._makeRequest("get", url);
            console.log(response);

            if (!response.results || response.results.length === 0) {
                throw new Error("No encounters found for this patient and encounter type");
            }

            const providerUuid = response.results[0].uuid;
            if (!providerUuid) {
                throw new Error("Provider not found in encounter");
            }

            console.log(`Provider UUID: ${providerUuid}`);
            return providerUuid;

        } catch (error) {
            console.error("Provider lookup failed:", error);
            throw new Error(`Failed to get provider UUID: ${error.message}`);
        }
    }


    async getVisitTypeId(visitType) {
        try {
            console.log(`Looking up visit type: ${visitType} `);

            const response = await this._makeRequest(
                "get",
                `${env.bahmni.baseUrl}/ws/rest/v1/visittype?q=${encodeURIComponent(visitType)} `
            );

            if (!response.results?.length) {
                throw new Error(`Visit type '${visitType}' not found`);
            }

            const visitTypeUuid = response.results[0].uuid;
            console.log(`Visit type UUID: ${visitTypeUuid} `);
            return visitTypeUuid;

        } catch (error) {
            console.error("Visit type lookup failed:", error);
            throw new Error(`Failed to get visit type UUID: ${error.message} `);
        }
    }

    async getEncounterTypeId(encounterType) {
        try {
            console.log(`Looking up encounter type: ${encounterType} `);

            const response = await this._makeRequest(
                "get",
                `${env.bahmni.baseUrl}/ws/rest/v1/encountertype?q=${encodeURIComponent(encounterType)} `
            );

            if (!response.results?.length) {
                throw new Error(`Encounter type '${encounterType}' not found`);
            }

            const encounterTypeUuid = response.results[0].uuid;
            console.log(`Encounter type UUID: ${encounterTypeUuid} `);
            return encounterTypeUuid;

        } catch (error) {
            console.error("Encounter type lookup failed:", error);
            throw new Error(`Failed to get encounter type UUID: ${error.message} `);
        }
    }

    async getLocationUuidByName(locationName) {
        try {
            console.log(`Looking up location: ${locationName} `);

            const response = await this._makeRequest(
                "get",
                `${env.bahmni.baseUrl}/ws/rest/v1/location?q=${encodeURIComponent(locationName)} `
            );

            if (!response.results?.length) {
                throw new Error(`Location '${locationName}' not found`);
            }

            const locationUuid = response.results[0].uuid;
            console.log(`Location UUID: ${locationUuid} `);
            return locationUuid;

        } catch (error) {
            console.error("Location lookup failed:", error);
            throw new Error(`Failed to get location UUID: ${error.message} `);
        }
    }

    async createVisit(patientUuid, visitType, locationName, startDate) {
        try {
            console.log(`Creating visit for patient ${patientUuid}...`);

            if (!startDate) {
                startDate = new Date();
                // startDate.setMonth(startDate.getMonth() - 1);
            }

            const [visitTypeUuid, locationUuid] = await Promise.all([
                this.getVisitTypeId(visitType),
                this.getLocationUuidByName(locationName),
            ]);

            const visitData = {
                patient: patientUuid,
                visitType: visitTypeUuid,
                startDatetime: startDate.toISOString(),
                location: locationUuid,
            };

            const response = await this._makeRequest(
                "post",
                `${env.bahmni.baseUrl}/ws/rest/v1/visit`,
                visitData
            );

            if (!response?.uuid) {
                throw new Error("Failed to create visit - no UUID returned");
            }

            console.log(`Visit created successfully - UUID: ${response.uuid} `);
            return response.uuid;

        } catch (error) {
            console.error("Visit creation failed:", error);
            throw new Error(`Failed to create visit: ${error.message} `);
        }
    }

    async getTestUuid() {
        // try {
        //     const response = await this._makeRequest('get', `${env.bahmni.baseUrl}/ws/rest/v1/concept?s=byFullySpecifiedName&name=Patient+Document&v=custom:(uuid,setMembers:(uuid, name: (name)))`);
        //     return response.results[0].setMembers[2].uuid;
        // } catch (err) {
        //     console.log("test uuid fetch error", err);
        //     throw new Error(`Failed to get uuid: ${err.message} `);
        // }
        return "c4694ad6-3f10-11e4-adec-0800271c1b75";
    }

    async verifyDetails(data) {
        try {
            console.log("verifying document to patient...");

            const response = await this._makeRequest(
                "post",
                `${env.bahmni.baseUrl}${env.bahmni.verifyDetails} `,
                data
            );

            console.log("Document verified successfully", response);
            return response;

        } catch (error) {
            console.error("Document linking failed:", error);
            throw new Error(`Failed to link document: ${error.message} `);
        }
    }

    async deleteDocument(documentUrl) {
        try {
            console.log("deleting the document...");

            const response = await this._makeRequest('delete', `${env.bahmni.baseUrl}/ws/rest/v1/bahmnicore/visitDocument?filename=${documentUrl} `);

            console.log("Document was deleted successfully")
            return response;
        } catch (error) {
            console.log(error)
        }
    }
    async getPatientMRN(mrn) {
        try {
            console.log('finding patient MRN')
            const response = await this._makeRequest('get', `${env.bahmni.baseUrl}/ws/rest/v1/patient?q=${encodeURIComponent(mrn)} `);
            return response || response.data;
        } catch (error) {
            console.log(error);
            throw error;
        }
    }
    async deleteVisit(visitUuid) {
        try {
            console.log('deleting patient visit')
            const response = await this._makeRequest('delete', `${env.bahmni.baseUrl}/ws/rest/v1/visit/${visitUuid}?reason=Entered%20in%20error`);
            return response;
        } catch (error) {
            console.log(error);
            throw error;
        }
    }

	async getActiveVisit(patientUuid) {
		try {
			const url = `${env.bahmni.baseUrl}/ws/rest/v1/visit?patient=${patientUuid}&v=full`;
			const response = await this._makeRequest("get", url);
			if (!response?.results) return null;
			const activeVisit = response.results.find(v => !v.stopDatetime) || null;
			return activeVisit || null;
		} catch (error) {
			// If patient has no visits
			if (error.statusCode === 404) return null;
			throw new Error(`Failed to get active visit: ${error.message}`);
		}
	}

	async getOrCreateActiveVisit(patientUuid, visitType, locationName) {
		try {
			const activeVisit = await this.getActiveVisit(patientUuid);
			if (activeVisit?.uuid) return activeVisit.uuid;
			return await this.createVisit(patientUuid, visitType, locationName);
		} catch (error) {
			throw new Error(`Failed to get or create active visit: ${error.message}`);
		}
	}

	async checkVisitExists(visitUuid) {
		try {
			const visitInfo = await this._makeRequest('get', `${env.bahmni.baseUrl}/ws/rest/v1/visit/${visitUuid}`);
			return {
				exists: !!visitInfo?.uuid,
				voided: !!visitInfo?.voided,
				active: !visitInfo?.stopDatetime
			};
		} catch (error) {
			if (error.statusCode === 404) {
				return { exists: false, voided: true, active: false };
			}
			throw new Error(`Failed to check visit existence: ${error.message}`);
		}
	}

	async getPatientVisits(patientUuid) {
		try {
			const url = `${env.bahmni.baseUrl}/ws/rest/v1/visit?patient=${patientUuid}&v=full`;
			const response = await this._makeRequest("get", url);
			return response?.results || [];
		} catch (error) {
			if (error.statusCode === 404) return [];
			throw new Error(`Failed to list patient visits: ${error.message}`);
		}
	}


}

const bahmniService = new BahmniService();

module.exports = {
    bahmniService,
};